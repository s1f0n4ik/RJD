#pragma once

#include <string>
#include <vector>

#include "utility/frames.h"
#include "bird-view/egl-context.h"
#include "bird-view/surround-camera.h"

namespace varan {
namespace birdview {

	/*
		Режим вывода линкера: top — плоская сшивка, surround — объёмный вид.

		Режим владеет своим рендерером и его настройкой; общий кадровый цикл,
		стример, тайминг и чтение пикселей живут в ULinker и одинаковы для всех.
	*/
	class IOutputMode {
	public:
		virtual ~IOutputMode() = default;

		// Готовит рендерер и отдаёт размер кадра вывода
		virtual bool prepare(int& out_width, int& out_height, std::string& error) = 0;

		// Порядок ключей камер, который ждёт заполнение кадрового пространства
		virtual std::vector<std::string> camera_keys() const = 0;

		// Живые изменения между кадрами; true - состав камер сменился,
		// и кадровое пространство надо пересоздать
		virtual bool apply_live_changes() { return false; }

		// Колбэки управления с сигналинга стримера; top их не потребляет
		virtual void bind_camera(USurroundCamera& camera) { (void)camera; }

		virtual void render_frame(std::vector<NPFrame>& frames, float dt, EGLDisplay display) = 0;
	};

} // birdview
} // varan
