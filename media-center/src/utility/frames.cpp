#include "utility/frames.h"

#include <sstream>
#include <drm/drm_fourcc.h>

#include "bird-view/gl-ext-loader.h"
#include "bird-view/utility.h"

namespace varan {

	size_t IGLTexture::get_texure_count() const { return m_textures.size(); }

	const std::optional<IGLTexture::FGLTexture> IGLTexture::get_texture(int index) const {
		if (index < 0 || index >= m_textures.size()) {
			return std::nullopt;
		}
		return m_textures[index];
	}

	void IGLTexture::add_texture(FGLTexture&& texture) { m_textures.push_back(std::move(texture)); }

	GLenum IGLTexture::from_gst_to_gl_format(GstGLFormat format) {
		switch (format) {
		case GST_GL_RGBA:
			return GL_RGBA8;
		case GST_GL_RGB:
			return GL_RGB8;
		case GST_GL_LUMINANCE:
			return GL_LUMINANCE;
		case GST_GL_LUMINANCE_ALPHA:
			return GL_LUMINANCE_ALPHA;
		case GST_GL_RED:
			return GL_R8;
		case GST_GL_RG:
			return GL_RG8;
		default:
			return GL_RGBA8;
		}
	}

	GLenum IGLTexture::from_gst_to_gl_target(GstGLTextureTarget target) {
		switch (target)
		{
		case GST_GL_TEXTURE_TARGET_2D:
			return GL_TEXTURE_2D;
		case GST_GL_TEXTURE_TARGET_EXTERNAL_OES:
			return GL_TEXTURE_EXTERNAL_OES;
		default:
			return GL_TEXTURE_2D;
		}
	}

	std::string IGLTexture::gl_format_to_string(GLenum format) {
		switch (format) {
		case GL_RGBA8:               return "GL_RGBA8";
		case GL_RGB8:                return "GL_RGB8";
		case GL_LUMINANCE:           return "GL_LUMINANCE";
		case GL_LUMINANCE_ALPHA:     return "GL_LUMINANCE_ALPHA";
		case GL_R8:                   return "GL_R8";
		case GL_RG8:                  return "GL_RG8";
		case GL_DEPTH_COMPONENT:     return "GL_DEPTH_COMPONENT";
		case GL_DEPTH_STENCIL:       return "GL_DEPTH_STENCIL";
		default:                     return "UNKNOWN_FORMAT";
		}
	}

	std::string IGLTexture::gl_target_to_string(GLenum target) {
		switch (target) {
		case GL_TEXTURE_2D:              return "GL_TEXTURE_2D";
		case GL_TEXTURE_EXTERNAL_OES:    return "GL_TEXTURE_EXTERNAL_OES";
		case GL_TEXTURE_3D:              return "GL_TEXTURE_3D";
		case GL_TEXTURE_CUBE_MAP:        return "GL_TEXTURE_CUBE_MAP";
		default:                         return "UNKNOWN_TARGET";
		}
	}

	// ****************************
	// Фреймы для dmabuf
	// ****************************

	UDmaFdFrame::~UDmaFdFrame() {
		close_fds();
	}

	UDmaFdFrame::UDmaFdFrame(UDmaFdFrame&& other) noexcept
		: fds(std::move(other.fds))
		, size(other.size)
		, planes(std::move(other.planes))
	{
		width = other.width;
		height = other.height;
		pts = other.pts;
		format = std::move(other.format);

		other.width = 0;
		other.height = 0;
		other.size = 0;
		other.pts = 0;
	}

	UDmaFdFrame& UDmaFdFrame::operator=(UDmaFdFrame&& other) noexcept
	{
		if (this != &other) {
			close_fds();

			fds = std::move(other.fds);
			width = other.width;
			height = other.height;
			size = other.size;
			pts = other.pts;
			format = std::move(other.format);
			planes = std::move(other.planes);

			other.width = 0;
			other.height = 0;
			other.size = 0;
			other.pts = 0;
		}
		return *this;
	}

	std::string UDmaFdFrame::to_string() {
		std::ostringstream ss;

		ss << "DMABUF Frame { " << "W=" << width << ", H=" << height << ", fmt=" << format
			<< ", size=" << size << "B" << ", pts=" << pts << ", fds=[";
		for (size_t i = 0; i < fds.size(); ++i) {
			ss << fds[i];
			if (i + 1 < fds.size()) {
				ss << ", ";
			}
		}
		ss << "], planes=[";
		for (size_t i = 0; i < planes.size(); ++i) {
			const auto& p = planes[i];
			ss << "{i=" << i << ", stride=" << p.stride << ", offset=" << p.offset << ", h=" << p.height << "}";

			if (i + 1 < planes.size()) {
				ss << ", ";
			}
		}
		ss << "] }";

		return ss.str();
	}

	void UDmaFdFrame::close_fds()
	{
		for (int fd : fds) {
			if (fd >= 0) {
				close(fd);
			}
		}
		fds.clear();
		planes.clear();
	}

	std::string UDmaFdFrame::type() {
		return "UDmaFdFrame";
	}

	// ****************************
	// GL Текстуры созданные из DMAbuf
	// ****************************

	UGLDmabufTexture::~UGLDmabufTexture() {
		destroy(m_display);
	}

	UGLDmabufTexture::UGLDmabufTexture(UGLDmabufTexture&& other) noexcept {
		move_from(std::move(other));
	}

	UGLDmabufTexture& UGLDmabufTexture::operator=(UGLDmabufTexture&& other) noexcept {
		if (this != &other) {
			destroy(m_display);
			move_from(std::move(other));
		}
		return *this;
	}

	bool UGLDmabufTexture::try_create_from_dma_frame(
		EGLDisplay display,
		const UDmaFdFrame& frame,
		EGLImageKHR& out_egl_image,
		IGLTexture::FGLTexture& out_texture,
		ULogger* logger
	) {
		// проверка инициализации указателей на функцию
		if (!birdview::g_gl.eglCreateImageKHR || !birdview::g_gl.glEGLImageTargetTexture2DOES) {
			logger->error("Cannot create texture from dmabuf: egl extenstions doesn't loaded");
			return false;
		}

		// Проверка fd
		if (!(frame.fds.size() == 1 || frame.fds.size() == frame.planes.size())) {
			if (logger) logger->error("egl image create(): linux fd from fram doesn't request egl image requirements!");
			return false;
		}

		auto get_fd = [&](size_t planeIndex) -> int {
			if (frame.fds.size() == 1) return frame.fds[0];
			return frame.fds[planeIndex];
			};

		// Создание изображений
		if (frame.format == "NV12" && frame.planes.size() == 2)
		{
			// формат NV12
			const auto& y = frame.planes[0];
			const auto& uv = frame.planes[1];

			EGLint attrs[] = {
				EGL_WIDTH, (EGLint)frame.width,
				EGL_HEIGHT, (EGLint)frame.height,
				EGL_LINUX_DRM_FOURCC_EXT, DRM_FORMAT_NV12,

				EGL_DMA_BUF_PLANE0_FD_EXT, get_fd(0),
				EGL_DMA_BUF_PLANE0_OFFSET_EXT, (EGLint)y.offset,
				EGL_DMA_BUF_PLANE0_PITCH_EXT, (EGLint)y.stride,

				EGL_DMA_BUF_PLANE1_FD_EXT, get_fd(0),
				EGL_DMA_BUF_PLANE1_OFFSET_EXT, (EGLint)uv.offset,
				EGL_DMA_BUF_PLANE1_PITCH_EXT, (EGLint)uv.stride,

				EGL_NONE
			};

			out_egl_image = birdview::g_gl.eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attrs);
			EGLint err = eglGetError();


			if (out_egl_image == EGL_NO_IMAGE_KHR) {
				std::ostringstream oss;
				oss << "egl image try_create_from_dma_frame(): cannot create egl image of y plane from frame with fd=" << get_fd(0)
					<< "; Error: " << birdview::eglErrorString(err) << " (0x" << std::hex << err << ")";
				if (logger) logger->trace(oss.str());
				return false;
			}
			else {
				if (logger) logger->trace("egl image try_create_from_dma_frame(): successfully created egl multiplaned image from frame fd=" + std::to_string(get_fd(0)));
			}

			glGenTextures(1, &out_texture.id);
			glBindTexture(GL_TEXTURE_EXTERNAL_OES, out_texture.id);

			glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
			glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
			glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
			glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

			birdview::g_gl.glEGLImageTargetTexture2DOES(GL_TEXTURE_EXTERNAL_OES, out_egl_image);

			out_texture.width = frame.width;
			out_texture.height = frame.height;
			out_texture.target = GL_TEXTURE_EXTERNAL_OES;
			out_texture.format = DRM_FORMAT_NV12;

			return true;
		}
		else {
			if (logger) logger->trace("egl image try_create_from_dma_frame(): not supported dma frame format <" + frame.format + "> for creation egl image");
		}

		return false;
	}

	bool UGLDmabufTexture::create(EGLDisplay display, std::optional<UDmaFdFrame>&& frame, ULogger* logger) {
		if (!frame.has_value()) {
			if (logger) logger->trace("egl image create(): dma frame is null");
			if (m_fds.size() != 0) {
				logger->trace("egl image create(): using prevoius frame");
			}
			return false;
		}

		EGLImageKHR new_image_egl = EGL_NO_IMAGE_KHR;
		IGLTexture::FGLTexture new_texture_egl;

		// Попытка создать dma frame
		if (try_create_from_dma_frame(display, frame.value(), new_image_egl, new_texture_egl, logger)) {
			// Если успешно - обновляем изображение, старое стираем
			destroy(display);

			m_textures.push_back(new_texture_egl);
			m_images.push_back(new_image_egl);

			m_fds = std::move(frame.value().fds);

			m_display = display;

			return true;
		}

		if (logger) logger->warn("egl image create(): failed, trying reuse previous frame");

		return false;
	}

	void UGLDmabufTexture::destroy(EGLDisplay display) {
		for (auto& tex : m_textures) {
			glDeleteTextures(1, &tex.id);
			tex.id = 0;
		}
		m_textures.clear();

		if (birdview::g_gl.eglDestroyImageKHR) {
			for (auto& egl_image : m_images) {
				if (egl_image != EGL_NO_IMAGE_KHR) {
					birdview::g_gl.eglDestroyImageKHR(display, egl_image);
					egl_image = EGL_NO_IMAGE_KHR;
				}
			}
		}
		m_images.clear();

		for (auto i = 0; i < m_fds.size(); i++) {
			if (m_fds[i] > 0) {
				close(m_fds[i]);
			}
		}
		m_fds.clear();
	}

	std::optional<EGLImageKHR> UGLDmabufTexture::get_egl_image(int index) {
		if (index < 0 || index >= m_images.size()) {
			return std::nullopt;
		}

		return m_images[index];
	}

	bool UGLDmabufTexture::has_texture() const {
		return (m_textures.size() != 0 && m_images.size() != 0 && m_textures.size() == m_images.size() && m_fds.size() != 0) ? true : false;
	}

	void UGLDmabufTexture::push_fd(int&& fd) {
		if (fd > 0) {
			m_fds.push_back(std::move(fd));
		}
	}

	void UGLDmabufTexture::move_from(UGLDmabufTexture&& other) {
		m_display = other.m_display;
		other.m_display = EGL_NO_DISPLAY;

		m_images = std::move(other.m_images);
		m_fds = std::move(other.m_fds);
		m_textures = std::move(other.m_textures);

		width = other.width;
		height = other.height;
		pts = other.pts;
		format = std::move(other.format);
	}

	std::string UGLDmabufTexture::to_string() {
		std::ostringstream ss;

		ss << "UGLDmabufTexture { "
			<< "W=" << width
			<< ", H=" << height
			<< ", fmt=" << format
			<< ", pts=" << pts
			<< ", fds=[";
		for (size_t i = 0; i < m_fds.size(); ++i) {
			ss << m_fds[i];
			if (i + 1 < m_fds.size()) ss << ", ";
		}
		ss << "], textures=[";

		for (size_t i = 0; i < m_textures.size(); ++i) {
			const auto& t = m_textures[i];
			ss << "{id=" << t.id
				<< ", W=" << t.width
				<< ", H=" << t.height
				<< ", target=" << IGLTexture::gl_target_to_string(t.target) << " (0x" << std::hex << t.target << std::dec << ")"
				<< ", format=" << IGLTexture::gl_format_to_string(t.format) << " (0x" << std::hex << t.format << std::dec << ")"
				<< "}";
			if (i + 1 < m_textures.size()) ss << ", ";
		}
		ss << "], egl_images=[";
		for (size_t i = 0; i < m_images.size(); ++i) {
			ss << m_images[i];
			if (i + 1 < m_images.size()) ss << ", ";
		}
		ss << "] }";

		return ss.str();
	}

	std::string UGLDmabufTexture::type() {
		return "UGLDmabufTexture";
	}

	// ****************************
	// GL Текстуры glupload
	// ****************************

	UGLTextureWrapper::UGLTextureWrapper(GstSample* sample) : m_sample(sample) {
		if (m_sample) {
			gst_sample_ref(m_sample);
			m_buffer = gst_sample_get_buffer(m_sample);
		}
	}

	UGLTextureWrapper::~UGLTextureWrapper() {
		destroy(EGL_NO_DISPLAY);
	}

	UGLTextureWrapper::UGLTextureWrapper(UGLTextureWrapper&& other) noexcept {
		move_from(std::move(other));
	}

	UGLTextureWrapper& UGLTextureWrapper::operator=(UGLTextureWrapper&& other) noexcept {
		if (this != &other) {
			destroy(EGL_NO_DISPLAY);
			move_from(std::move(other));
		}
		return *this;
	}

	GstBuffer* UGLTextureWrapper::buffer() const {
		return m_buffer;
	}

	void UGLTextureWrapper::destroy(EGLDisplay display) {
		// Удалять текстуры, которыми владеет GStreamer - не нужно
		//for (auto& texture : m_textures) {
		//	glDeleteTextures(1, &texture.id);
		//	texture.id = 0;
		//}
		m_textures.clear();
		
		if (m_sample) {
			gst_sample_unref(m_sample);
			m_sample = nullptr;
			m_buffer = nullptr;
		}
	}

	void UGLTextureWrapper::move_from(UGLTextureWrapper&& other) {
		format = std::move(other.format);
		width = other.width;
		height = other.height;
		pts = other.pts;

		m_textures = std::move(other.m_textures);

		m_buffer = other.m_buffer;
		other.m_buffer = nullptr;
	}

	std::string UGLTextureWrapper::to_string() {
		std::ostringstream ss;

		ss << "UGLTextureWrapper { "
			<< "W=" << width
			<< ", H=" << height
			<< ", fmt=" << format
			<< ", pts=" << pts
			<< ", textures=[";

		for (size_t i = 0; i < m_textures.size(); ++i) {
			const auto& t = m_textures[i];
			ss << "{id=" << t.id
				<< ", W=" << t.width
				<< ", H=" << t.height
				<< ", target=" << IGLTexture::gl_target_to_string(t.target) << " (0x" << std::hex << t.target << std::dec << ")"
				<< ", format=" << IGLTexture::gl_format_to_string(t.format) << " (0x" << std::hex << t.format << std::dec << ")"
				<< "}";
			if (i + 1 < m_textures.size()) ss << ", ";
		}
		ss << "], buffer=" << m_buffer
			<< " }";

		return ss.str();
	}

	std::string UGLTextureWrapper::type() {
		return "UGLTextureWrapper";
	}
		
} // varan