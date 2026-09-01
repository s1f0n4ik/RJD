#pragma once

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>

#include <gst/gst.h>

namespace varan {
namespace core {

	// Снятие ветки с tee из IDLE-пробы; false — проба не сработала, отцепили напрямую
	inline bool detach_tee_pad(
		GstElement* tee,
		GstPad* tee_pad,
		GstElement* branch_queue,
		std::chrono::milliseconds wait = std::chrono::seconds(2)
	) {
		if (!tee || !tee_pad) {
			return false;
		}

		struct FDetachState {
			GstElement* tee = nullptr;
			GstElement* queue = nullptr;
			std::mutex mutex;
			std::condition_variable cv;
			bool taken = false;
			bool done = false;

			void unlink(GstPad* pad) {
				GstPad* queue_sink = queue ? gst_element_get_static_pad(queue, "sink") : nullptr;
				if (queue_sink) {
					gst_pad_unlink(pad, queue_sink);
					gst_object_unref(queue_sink);
				}
				gst_element_release_request_pad(tee, pad);
			}
		};

		auto state = std::make_shared<FDetachState>();
		state->tee = tee;
		state->queue = branch_queue;

		// Проба может сработать и после выхода отсюда
		auto* holder = new std::shared_ptr<FDetachState>(state);

		gst_pad_add_probe(
			tee_pad,
			GST_PAD_PROBE_TYPE_IDLE,
			[](GstPad* pad, GstPadProbeInfo*, gpointer data) -> GstPadProbeReturn {
				auto& shared = *static_cast<std::shared_ptr<FDetachState>*>(data);

				{
					std::lock_guard<std::mutex> lock(shared->mutex);
					if (shared->taken) {
						return GST_PAD_PROBE_REMOVE;
					}
					shared->taken = true;
				}

				shared->unlink(pad);

				{
					std::lock_guard<std::mutex> lock(shared->mutex);
					shared->done = true;
				}
				shared->cv.notify_all();

				return GST_PAD_PROBE_REMOVE;
			},
			holder,
			+[](gpointer data) { delete static_cast<std::shared_ptr<FDetachState>*>(data); }
		);

		std::unique_lock<std::mutex> lock(state->mutex);
		if (state->cv.wait_for(lock, wait, [&] { return state->done; })) {
			return true;
		}

		if (state->taken) {
			return false;
		}

		state->taken = true;
		lock.unlock();

		// Мёртвая камера буферов не дает, а ветку снимать надо
		state->unlink(tee_pad);
		return false;
	}

	struct FAttachResult {
		// Ссылку освобождает вызыватель
		GstPad* pad = nullptr;
		bool linked = false;
		bool at_idle = false;
	};

	// Подключение ветки к tee из IDLE-пробы
	inline FAttachResult attach_tee_pad(
		GstElement* tee,
		GstElement* branch_queue,
		std::chrono::milliseconds wait = std::chrono::milliseconds(300)
	) {
		FAttachResult result;
		if (!tee || !branch_queue) {
			return result;
		}

		result.pad = gst_element_request_pad_simple(tee, "src_%u");
		if (!result.pad) {
			return result;
		}

		struct FAttachState {
			GstElement* queue = nullptr;
			std::mutex mutex;
			std::condition_variable cv;
			bool taken = false;
			bool done = false;
			bool linked = false;

			void link(GstPad* pad) {
				GstPad* queue_sink = gst_element_get_static_pad(queue, "sink");
				if (!queue_sink) {
					return;
				}
				linked = gst_pad_link(pad, queue_sink) == GST_PAD_LINK_OK;
				gst_object_unref(queue_sink);
			}
		};

		auto state = std::make_shared<FAttachState>();
		state->queue = branch_queue;

		auto* holder = new std::shared_ptr<FAttachState>(state);

		gst_pad_add_probe(
			result.pad,
			GST_PAD_PROBE_TYPE_IDLE,
			[](GstPad* pad, GstPadProbeInfo*, gpointer data) -> GstPadProbeReturn {
				auto& shared = *static_cast<std::shared_ptr<FAttachState>*>(data);

				{
					std::lock_guard<std::mutex> lock(shared->mutex);
					if (shared->taken) {
						return GST_PAD_PROBE_REMOVE;
					}
					shared->taken = true;
				}

				shared->link(pad);

				{
					std::lock_guard<std::mutex> lock(shared->mutex);
					shared->done = true;
				}
				shared->cv.notify_all();

				return GST_PAD_PROBE_REMOVE;
			},
			holder,
			+[](gpointer data) { delete static_cast<std::shared_ptr<FAttachState>*>(data); }
		);

		std::unique_lock<std::mutex> lock(state->mutex);
		if (state->cv.wait_for(lock, wait, [&] { return state->done; })) {
			result.linked = state->linked;
			result.at_idle = true;
			return result;
		}

		if (state->taken) {
			return result;
		}

		state->taken = true;
		lock.unlock();

		state->link(result.pad);
		result.linked = state->linked;
		return result;
	}

} // namespace core
} // namespace varan
