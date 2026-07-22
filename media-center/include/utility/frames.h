#pragma once

#include <string>
#include <vector>
#include <optional>
#include <functional>
#include <memory>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>

#include <gst/gst.h>
#include <gst/gl/gl.h>

#include "logger.h"

namespace varan {

	struct GLFormatDesc
	{
		GLenum internal_format;
		GLenum colorspace;
		GLenum byte_type;
	};

	class IFrame {
		public:
			virtual ~IFrame() = default;

			virtual std::string to_string() = 0;

			virtual std::string type() = 0;

		public:
			uint32_t width;
			uint32_t height;
			uint64_t pts;
			std::string format;
	};

	class IGLTexture {
		public:

			struct FGLTexture {
				GLuint id;
				guint width;
				guint height;
				GLenum target;
				GLenum format;
			};

			virtual ~IGLTexture() = default;

			// Методы для работы с текстурами
			size_t get_texure_count() const;
			const std::optional<FGLTexture> get_texture(int index) const;
			void add_texture(FGLTexture&& texture);

			virtual void destroy(EGLDisplay display) = 0;

			static GLenum from_gst_to_gl_format(GstGLFormat format);
			static GLenum from_gst_to_gl_target(GstGLTextureTarget target);

			static std::string gl_format_to_string(GLenum format);
			static std::string gl_target_to_string(GLenum target);

		protected:
			std::vector<FGLTexture> m_textures;
	};

	// Кадр разделяется между storage и всеми потребителями. Сам объект кадра
	// создаётся один раз, а std::move при публикации передаёт storage первую
	// ссылку без лишнего изменения счётчика.
	using NPFrame = std::shared_ptr<IFrame>;
	using NPGLTexture = std::shared_ptr<IGLTexture>;
	using CFrameMover = std::function<void(std::string, NPFrame)>;

	class UDmaFdFrame : public IFrame {
		public:
			struct FDmabufPlane {
				uint32_t stride = 0;
				uint32_t offset = 0;
				uint32_t height = 0;
			};

			UDmaFdFrame() = default;
			~UDmaFdFrame();

			// Запрет копирования
			UDmaFdFrame(const UDmaFdFrame&) = delete;
			UDmaFdFrame& operator=(const UDmaFdFrame&) = delete;

			// Настройка перемещения
			UDmaFdFrame(UDmaFdFrame&& other) noexcept;
			UDmaFdFrame& operator=(UDmaFdFrame&& other) noexcept;

			virtual std::string to_string() override;

			virtual std::string type() override;

		public:
			std::vector<FDmabufPlane> planes;
			std::vector<int> fds;

			size_t size = 0;

		private:
			void close_fds();
	};

	class UGLDmabufTexture: public IFrame, public IGLTexture {
		public:

			~UGLDmabufTexture();

			UGLDmabufTexture(const UGLDmabufTexture&) = delete;
			UGLDmabufTexture& operator=(const UGLDmabufTexture&) = delete;

			UGLDmabufTexture(UGLDmabufTexture&& other) noexcept;
			UGLDmabufTexture& operator=(UGLDmabufTexture&& other) noexcept;

			bool create(EGLDisplay display, std::optional<UDmaFdFrame>&& frame, ULogger* logger);

			std::optional<EGLImageKHR> get_egl_image(int index);

			void push_fd(int&& fd);

			bool has_texture() const;

			virtual std::string to_string() override;

			virtual std::string type() override;

		private:
			bool try_create_from_dma_frame(
				EGLDisplay display,
				const UDmaFdFrame& frame,
				EGLImageKHR& out_egl_image,
				IGLTexture::FGLTexture& out_texture,
				ULogger* logger
			);

			virtual void destroy(EGLDisplay display) override;

			void move_from(UGLDmabufTexture&& other);

		private:
			EGLDisplay m_display = EGL_NO_DISPLAY;

			std::vector<EGLImageKHR> m_images;
			std::vector<int> m_fds;
	};

	class UGLTextureWrapper: public IFrame, public IGLTexture {
	public:
		UGLTextureWrapper() = default;
		explicit UGLTextureWrapper(GstSample* sample);
		~UGLTextureWrapper();

		UGLTextureWrapper(const UGLTextureWrapper&) = delete;
		UGLTextureWrapper& operator=(const UGLTextureWrapper&) = delete;

		UGLTextureWrapper(UGLTextureWrapper&& other) noexcept;
		UGLTextureWrapper& operator=(UGLTextureWrapper&& other) noexcept;

		GstBuffer* buffer() const;

		virtual void destroy(EGLDisplay display) override;

		virtual std::string to_string() override;

		virtual std::string type() override;

	private:
		GstBuffer* m_buffer = nullptr;
		GstSample* m_sample = nullptr;

	private:
		void move_from(UGLTextureWrapper&& other);
	};

	// То же самое, что и UGLTextureWrapper, но специально под shared_ptr
	class USharedGLTextureWrapper: public IFrame, public IGLTexture {
	public:
		USharedGLTextureWrapper() = default;
		explicit USharedGLTextureWrapper(GstSample* sample);
		~USharedGLTextureWrapper() override = default;

		USharedGLTextureWrapper(const USharedGLTextureWrapper&) = default;
		USharedGLTextureWrapper& operator=(const USharedGLTextureWrapper&) = default;
		USharedGLTextureWrapper(USharedGLTextureWrapper&&) noexcept = default;
		USharedGLTextureWrapper& operator=(USharedGLTextureWrapper&&) noexcept = default;

		GstBuffer* buffer() const;
		bool has_sample() const;

		void destroy(EGLDisplay display) override;
		std::string to_string() override;
		std::string type() override;

	private:
		std::shared_ptr<GstSample> m_sample;
	};

	using SPGLTextureWrapper = std::shared_ptr<USharedGLTextureWrapper>;

} // varan
