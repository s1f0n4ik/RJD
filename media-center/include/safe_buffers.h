#include <vector>
#include <mutex>
#include <condition_variable>
#include <optional>
#include <memory>
#include <queue>

// ====================================
// Ring Buffer
// ====================================

template<typename T>
class URingBuffer {
public:
    explicit URingBuffer(size_t m_capacity) 
        : m_buffer(m_capacity), m_capacity(m_capacity), m_head(0), m_tail(0), m_full(false)
    {
    }

    // Добавить элемент (перезаписывает, если полный)
    void push(T m_item) {
        std::unique_lock lock(m_mutex);

        m_buffer[m_head] = std::move(m_item);
        m_head = (m_head + 1) % m_capacity;

        if (m_full) {
            // При переполнении сдвигаем хвост, теряя самый старый элемент
            m_tail = (m_tail + 1) % m_capacity;
        }

        m_full = m_head == m_tail;
        m_cv.notify_one();
    }

    // Попытка взять следующий элемент из буфера (если пуст — optional пуст)
    std::optional<T> pop() {
        std::unique_lock lock(m_mutex);

        if (empty_locked()) {
            return std::nullopt;
        }

        T m_item = std::move(m_buffer[m_tail]);
        m_tail = (m_tail + 1) % m_capacity;
        m_full = false;

        return m_item;
    }

    std::optional<T> peek() {
        std::unique_lock lock(m_mutex);

        if (empty_locked()) {
            return std::nullopt;
        }

        size_t last = (m_head + m_capacity - 1) % m_capacity;
        return m_buffer[last];
    }

    // Проверка, пуст ли буфер
    bool empty() {
        std::unique_lock lock(m_mutex);
        return empty_locked();
    }

    // Проверка, полный ли буфер
    bool full() {
        std::unique_lock lock(m_mutex);
        return m_full;
    }

    // Количество элементов (приближённо)
    size_t size() {
        std::unique_lock lock(m_mutex);
        if (m_full) {
            return m_capacity;
        }
        if (m_head >= m_tail) {
            return m_head - m_tail;
        }
        return m_capacity + m_head - m_tail;
    }

private:
    bool empty_locked() const {
        return (!m_full && (m_head == m_tail));
    }

private:
    std::vector<T> m_buffer;
    const size_t m_capacity;
    size_t m_head;
    size_t m_tail;
    bool m_full;

    mutable std::mutex m_mutex;
    std::condition_variable m_cv;
};

// ====================================
// Safe Queue
// ====================================

template<typename T>
class USafeQueue {
public:
    explicit USafeQueue(size_t max_size) : m_max_size(max_size) {}

    void push(T item) {
        {
            std::lock_guard lock(m_mutex);
            if (m_queue.size() >= m_max_size) {
                m_queue.pop();
            }
            m_queue.push(std::move(item));
        }
        m_cv.notify_one();
    }

    T wait_and_pop() {
        std::unique_lock lock(m_mutex);
        m_cv.wait(lock, [this] { return !m_queue.empty(); });
        T item = std::move(m_queue.front());
        m_queue.pop();
        return item;
    }

    bool empty() {
        std::lock_guard lock(m_mutex);
        return m_queue.empty();
    }

private:
    std::queue<T> m_queue;
    std::mutex m_mutex;
    std::condition_variable m_cv;
    size_t m_max_size;
};
