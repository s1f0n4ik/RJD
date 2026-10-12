#include "gateway/modules/modbus/queue.h"
#include "gateway/utility/log.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

#if defined(__unix__)
#include <fcntl.h>
#include <unistd.h>
#endif

namespace varan {
    namespace gateway {

        namespace {

            const char* TAG = "modbus:queue";
            const char MAGIC[4] = { 'M', 'B', 'Q', '2' };

            template <typename T>
            void put(std::string& s, T v) {
                s.append(reinterpret_cast<const char*>(&v), sizeof(T));
            }

            template <typename T>
            bool get(const std::string& s, std::size_t& pos, T& v) {
                if (pos + sizeof(T) > s.size()) {
                    return false;
                }
                std::memcpy(&v, s.data() + pos, sizeof(T));
                pos += sizeof(T);
                return true;
            }

            bool write_atomic(const std::string& path, const std::string& data, std::string& err) {
                const std::string tmp = path + ".tmp";
#if defined(__unix__)
                const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
                if (fd < 0) {
                    err = "open " + tmp + ": " + std::strerror(errno);
                    return false;
                }
                std::size_t off = 0;
                while (off < data.size()) {
                    const ssize_t n = ::write(fd, data.data() + off, data.size() - off);
                    if (n < 0) {
                        if (errno == EINTR) {
                            continue;
                        }
                        err = "write " + tmp + ": " + std::strerror(errno);
                        ::close(fd);
                        return false;
                    }
                    off += static_cast<std::size_t>(n);
                }
                if (::fsync(fd) != 0) {
                    err = "fsync " + tmp + ": " + std::strerror(errno);
                    ::close(fd);
                    return false;
                }
                ::close(fd);
                if (std::rename(tmp.c_str(), path.c_str()) != 0) {
                    err = "rename " + tmp + ": " + std::strerror(errno);
                    return false;
                }
                // Сброс каталога на диск
                const auto slash = path.find_last_of('/');
                const std::string dir = slash == std::string::npos ? "." : (slash == 0 ? "/" : path.substr(0, slash));
                const int dfd = ::open(dir.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
                if (dfd >= 0) {
                    ::fsync(dfd);
                    ::close(dfd);
                }
                return true;
#else
                {
                    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
                    out.write(data.data(), static_cast<std::streamsize>(data.size()));
                    if (!out) {
                        err = "write " + tmp;
                        return false;
                    }
                }
                std::remove(path.c_str());
                if (std::rename(tmp.c_str(), path.c_str()) != 0) {
                    err = "rename " + tmp;
                    return false;
                }
                return true;
#endif
            }

        } // namespace

        UModbusQueue::UModbusQueue(std::string path)
            : m_path(std::move(path))
        {
            if (m_path.empty()) {
                return;
            }
            load();
            m_writer = std::thread([this] { writer_loop(); });
        }

        UModbusQueue::~UModbusQueue() {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_stop = true;
            }
            m_cv.notify_all();
            if (m_writer.joinable()) {
                m_writer.join();
            }
        }

        // MBQ2, номер следующей, выброшено, число записей; запись: номер, скрыта, время, пакет, длина, регистры
        void UModbusQueue::load() {
            std::string data;
            {
                std::ifstream in(m_path, std::ios::binary);
                if (!in) {
                    return;
                }
                std::stringstream ss;
                ss << in.rdbuf();
                data = ss.str();
            }

            std::deque<FModbusRecord> records;
            std::uint16_t next = 1;
            std::int64_t dropped = 0;
            std::uint32_t count = 0;
            std::size_t pos = sizeof(MAGIC);
            bool ok = data.size() >= sizeof(MAGIC) && std::memcmp(data.data(), MAGIC, sizeof(MAGIC)) == 0
                && get(data, pos, next) && get(data, pos, dropped) && get(data, pos, count) && count <= CAPACITY;
            for (std::uint32_t i = 0; ok && i < count; ++i) {
                FModbusRecord r;
                std::uint8_t hidden = 0;
                std::uint16_t length = 0;
                ok = get(data, pos, r.number) && get(data, pos, hidden) && get(data, pos, r.utc_ms)
                    && get(data, pos, r.packet) && get(data, pos, length) && length >= 2 && length <= WINDOW;
                r.regs.resize(length);
                for (std::uint16_t j = 0; ok && j < length; ++j) {
                    ok = get(data, pos, r.regs[j]);
                }
                r.hidden = hidden != 0;
                records.push_back(std::move(r));
            }
            if (!ok || pos != data.size()) {
                ULog::warn(TAG, "Queue file is corrupt or of an older format, moved to " + m_path + ".corrupt");
                std::rename(m_path.c_str(), (m_path + ".corrupt").c_str());
                return;
            }

            m_records = std::move(records);
            m_next = next;
            m_dropped = dropped;
            m_hidden = static_cast<std::size_t>(std::count_if(m_records.begin(), m_records.end(),
                [](const FModbusRecord& r) { return r.hidden; }));
            ULog::info(TAG, "Restored " + std::to_string(m_records.size()) + " record(s), " +
                std::to_string(m_hidden) + " hidden, from " + m_path);
        }

        std::string UModbusQueue::serialize_locked() const {
            std::string s;
            s.reserve(sizeof(MAGIC) + 14 + m_records.size() * 80);
            s.append(MAGIC, sizeof(MAGIC));
            put(s, m_next);
            put(s, m_dropped);
            put(s, static_cast<std::uint32_t>(m_records.size()));
            for (const auto& r : m_records) {
                put(s, r.number);
                put(s, static_cast<std::uint8_t>(r.hidden));
                put(s, r.utc_ms);
                put(s, r.packet);
                put(s, static_cast<std::uint16_t>(r.regs.size()));
                s.append(reinterpret_cast<const char*>(r.regs.data()), r.regs.size() * sizeof(std::uint16_t));
            }
            return s;
        }

        void UModbusQueue::touch_locked() {
            if (m_path.empty()) {
                return;
            }
            m_dirty = true;
            m_cv.notify_one();
        }

        void UModbusQueue::writer_loop() {
            std::string last_err;
            std::unique_lock<std::mutex> lock(m_mutex);
            while (true) {
                m_cv.wait(lock, [this] { return m_dirty || m_stop; });
                if (!m_dirty) {
                    return;
                }
                m_dirty = false;
                const std::string blob = serialize_locked();
                lock.unlock();
                std::string err;
                if (!write_atomic(m_path, blob, err) && err != last_err) {
                    ULog::warn(TAG, err);
                }
                last_err = err;
                lock.lock();
            }
        }

        void UModbusQueue::set_recent_locked(std::uint16_t number, const char* status) {
            for (auto it = m_recent.rbegin(); it != m_recent.rend(); ++it) {
                if (it->r.number == number) {
                    it->status = status;
                    return;
                }
            }
        }

        std::size_t UModbusQueue::window_records_locked() const {
            const std::size_t visible = m_records.size() - m_hidden;
            std::size_t used = 0;
            std::size_t n = 0;
            while (n < visible && used + m_records[n].regs.size() <= WINDOW) {
                used += m_records[n].regs.size();
                ++n;
            }
            return n;
        }

        std::uint16_t UModbusQueue::push(FModbusRecord r) {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_records.size() >= CAPACITY) {
                const FModbusRecord& old = m_records.front();
                ULog::warn(TAG, "Queue is full (" + std::to_string(CAPACITY) + "), oldest record #" +
                    std::to_string(old.number) + " dropped");
                set_recent_locked(old.number, "dropped");
                if (old.hidden) {
                    --m_hidden;
                }
                m_records.pop_front();
                ++m_dropped;
            }
            r.number = m_next;
            r.regs[1] = r.number;
            // После 65535 нумерация идёт с 0
            m_next = static_cast<std::uint16_t>(m_next + 1);
            if (r.hidden) {
                ++m_hidden;
            }
            m_recent.push_back(FRecent{ r, r.hidden ? "hidden" : "queued" });
            if (m_recent.size() > RECENT) {
                m_recent.pop_front();
            }
            m_records.push_back(std::move(r));
            touch_locked();
            return m_records.back().number;
        }

        int UModbusQueue::reveal(std::int64_t offset_ms, const CRestamp& restamp) {
            std::lock_guard<std::mutex> lock(m_mutex);
            int n = 0;
            for (auto& r : m_records) {
                if (r.hidden) {
                    r.hidden = false;
                    r.utc_ms += offset_ms;
                    restamp(r);
                    ++n;
                }
            }
            for (auto& e : m_recent) {
                if (e.r.hidden) {
                    e.r.hidden = false;
                    e.r.utc_ms += offset_ms;
                    restamp(e.r);
                    if (e.status == "hidden") {
                        e.status = "queued";
                    }
                }
            }
            m_hidden = 0;
            if (n) {
                touch_locked();
            }
            return n;
        }

        UModbusQueue::FMarkResult UModbusQueue::mark(std::uint16_t first, std::uint16_t last) {
            std::lock_guard<std::mutex> lock(m_mutex);
            FMarkResult res;
            const std::size_t visible = m_records.size() - m_hidden;
            res.head = visible ? m_records.front().number : 0;
            if (!visible || first != res.head) {
                return res;
            }
            // Номера идут по кругу 0–65535
            const std::size_t n = static_cast<std::uint16_t>(last - first) + std::size_t{ 1 };
            if (n > window_records_locked()) {
                return res;
            }
            for (std::size_t i = 0; i < n; ++i) {
                set_recent_locked(m_records.front().number, "read");
                m_records.pop_front();
            }
            res.ok = true;
            res.removed = static_cast<int>(n);
            touch_locked();
            return res;
        }

        std::uint16_t UModbusQueue::visible() const {
            std::lock_guard<std::mutex> lock(m_mutex);
            return static_cast<std::uint16_t>(std::min<std::size_t>(m_records.size() - m_hidden, 65535));
        }

        bool UModbusQueue::uniform(std::size_t length) const {
            std::lock_guard<std::mutex> lock(m_mutex);
            return std::all_of(m_records.begin(), m_records.end(),
                [length](const FModbusRecord& r) { return r.regs.size() == length; });
        }

        std::vector<std::uint16_t> UModbusQueue::window(std::size_t offset, std::size_t count, std::uint16_t* out) const {
            std::lock_guard<std::mutex> lock(m_mutex);
            std::fill(out, out + count, 0);
            std::vector<std::uint16_t> numbers;
            const std::size_t shown = window_records_locked();
            const std::size_t end = offset + count;
            std::size_t start = 0;
            for (std::size_t i = 0; i < shown && start < end; ++i) {
                const auto& regs = m_records[i].regs;
                const std::size_t from = std::max(start, offset);
                const std::size_t to = std::min(start + regs.size(), end);
                if (from < to) {
                    std::copy(regs.begin() + static_cast<std::ptrdiff_t>(from - start),
                        regs.begin() + static_cast<std::ptrdiff_t>(to - start), out + (from - offset));
                    numbers.push_back(m_records[i].number);
                }
                start += regs.size();
            }
            return numbers;
        }

        UModbusQueue::FSnapshot UModbusQueue::snapshot() const {
            std::lock_guard<std::mutex> lock(m_mutex);
            FSnapshot s;
            s.total = m_records.size();
            s.visible = m_records.size() - m_hidden;
            s.hidden = m_hidden;
            s.window = window_records_locked();
            s.dropped = m_dropped;
            s.next = m_next;
            s.recent.assign(m_recent.rbegin(), m_recent.rend());
            if (s.visible) {
                s.head = m_records.front();
            }
            return s;
        }

    } // namespace gateway
} // namespace varan
