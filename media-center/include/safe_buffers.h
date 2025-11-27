#include <vector>
#include <mutex>
#include <condition_variable>
#include <optional>
#include <memory>
#include <queue>

// ====================================
// Ring Buffer
// ====================================

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
