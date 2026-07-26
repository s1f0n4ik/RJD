#include "bird-view/surround-model.h"

#define TINYGLTF_IMPLEMENTATION
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define TINYGLTF_NO_EXTERNAL_IMAGE
#include "tiny_gltf.h"

#include <gtc/matrix_transform.hpp>
#include <gtc/type_ptr.hpp>

#include <algorithm>
#include <cstring>
#include <limits>
#include <unordered_map>

namespace varan {
namespace birdview {

	namespace {

		// Страховка от моделей, которые GPU платы не потянет каждый кадр
		constexpr size_t MODEL_MAX_VERTICES = 2'000'000;

		// Значение компоненты аксессора как float с учётом normalized-типов
		float component_value(const uint8_t* p, int component_type, bool normalized) {
			switch (component_type) {
			case TINYGLTF_COMPONENT_TYPE_FLOAT: {
				float f; std::memcpy(&f, p, sizeof(float)); return f;
			}
			case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: {
				const float v = static_cast<float>(*p);
				return normalized ? v / 255.0f : v;
			}
			case TINYGLTF_COMPONENT_TYPE_BYTE: {
				int8_t v; std::memcpy(&v, p, 1);
				return normalized ? std::max(v / 127.0f, -1.0f) : static_cast<float>(v);
			}
			case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: {
				uint16_t v; std::memcpy(&v, p, 2);
				return normalized ? v / 65535.0f : static_cast<float>(v);
			}
			case TINYGLTF_COMPONENT_TYPE_SHORT: {
				int16_t v; std::memcpy(&v, p, 2);
				return normalized ? std::max(v / 32767.0f, -1.0f) : static_cast<float>(v);
			}
			default:
				return 0.0f;
			}
		}

		int component_size(int component_type) {
			switch (component_type) {
			case TINYGLTF_COMPONENT_TYPE_BYTE:
			case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: return 1;
			case TINYGLTF_COMPONENT_TYPE_SHORT:
			case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: return 2;
			case TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT:
			case TINYGLTF_COMPONENT_TYPE_FLOAT: return 4;
			default: return 0;
			}
		}

		// Аксессор в плоский массив float по components штук на элемент
		bool read_accessor(
			const tinygltf::Model& model,
			int accessor_index,
			int components,
			std::vector<float>& out)
		{
			if (accessor_index < 0 || accessor_index >= static_cast<int>(model.accessors.size())) {
				return false;
			}
			const auto& acc = model.accessors[accessor_index];
			if (acc.bufferView < 0) return false;
			const auto& view = model.bufferViews[acc.bufferView];
			const auto& buffer = model.buffers[view.buffer];

			const int comp_size = component_size(acc.componentType);
			const int comp_count = tinygltf::GetNumComponentsInType(acc.type);
			if (comp_size == 0 || comp_count < components) return false;

			const int byte_stride = acc.ByteStride(view);
			if (byte_stride <= 0) return false;
			const size_t stride = static_cast<size_t>(byte_stride);
			const uint8_t* base = buffer.data.data() + view.byteOffset + acc.byteOffset;

			out.resize(acc.count * components);
			for (size_t i = 0; i < acc.count; ++i) {
				const uint8_t* elem = base + i * stride;
				for (int c = 0; c < components; ++c) {
					out[i * components + c] = component_value(
						elem + static_cast<size_t>(c) * comp_size,
						acc.componentType, acc.normalized);
				}
			}
			return true;
		}

		bool read_indices(const tinygltf::Model& model, int accessor_index, std::vector<uint32_t>& out) {
			const auto& acc = model.accessors[accessor_index];
			if (acc.bufferView < 0) return false;
			const auto& view = model.bufferViews[acc.bufferView];
			const auto& buffer = model.buffers[view.buffer];

			const int byte_stride = acc.ByteStride(view);
			if (byte_stride <= 0) return false;
			const size_t stride = static_cast<size_t>(byte_stride);
			const uint8_t* base = buffer.data.data() + view.byteOffset + acc.byteOffset;

			out.resize(acc.count);
			for (size_t i = 0; i < acc.count; ++i) {
				const uint8_t* p = base + i * stride;
				switch (acc.componentType) {
				case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: out[i] = *p; break;
				case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: {
					uint16_t v; std::memcpy(&v, p, 2); out[i] = v; break;
				}
				case TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT: {
					uint32_t v; std::memcpy(&v, p, 4); out[i] = v; break;
				}
				default: return false;
				}
			}
			return true;
		}

		glm::mat4 node_matrix(const tinygltf::Node& node) {
			if (node.matrix.size() == 16) {
				glm::mat4 m;
				for (int i = 0; i < 16; ++i) glm::value_ptr(m)[i] = static_cast<float>(node.matrix[i]);
				return m;
			}
			glm::mat4 m(1.0f);
			if (node.translation.size() == 3) {
				m = glm::translate(m, glm::vec3(
					static_cast<float>(node.translation[0]),
					static_cast<float>(node.translation[1]),
					static_cast<float>(node.translation[2])));
			}
			if (node.rotation.size() == 4) {
				// glTF хранит кватернион xyzw
				const float x = static_cast<float>(node.rotation[0]);
				const float y = static_cast<float>(node.rotation[1]);
				const float z = static_cast<float>(node.rotation[2]);
				const float w = static_cast<float>(node.rotation[3]);
				glm::mat4 r(1.0f);
				r[0][0] = 1 - 2 * (y * y + z * z); r[1][0] = 2 * (x * y - z * w); r[2][0] = 2 * (x * z + y * w);
				r[0][1] = 2 * (x * y + z * w); r[1][1] = 1 - 2 * (x * x + z * z); r[2][1] = 2 * (y * z - x * w);
				r[0][2] = 2 * (x * z - y * w); r[1][2] = 2 * (y * z + x * w); r[2][2] = 1 - 2 * (x * x + y * y);
				m = m * r;
			}
			if (node.scale.size() == 3) {
				m = glm::scale(m, glm::vec3(
					static_cast<float>(node.scale[0]),
					static_cast<float>(node.scale[1]),
					static_cast<float>(node.scale[2])));
			}
			return m;
		}

		struct FBakeContext {
			const tinygltf::Model* model = nullptr;
			FSurroundModel* out = nullptr;
			// Индекс image -> индекс в out->textures, декод один раз
			std::unordered_map<int, int> texture_map;
			std::string error;
		};

		int bake_texture(FBakeContext& ctx, int material_index, float base_color[4]) {
			base_color[0] = base_color[1] = base_color[2] = base_color[3] = 1.0f;
			if (material_index < 0
				|| material_index >= static_cast<int>(ctx.model->materials.size())) {
				return -1;
			}
			const auto& pbr = ctx.model->materials[material_index].pbrMetallicRoughness;
			for (int i = 0; i < 4; ++i) {
				base_color[i] = static_cast<float>(pbr.baseColorFactor[i]);
			}

			const int tex_index = pbr.baseColorTexture.index;
			if (tex_index < 0 || tex_index >= static_cast<int>(ctx.model->textures.size())) {
				return -1;
			}
			const int image_index = ctx.model->textures[tex_index].source;
			if (image_index < 0 || image_index >= static_cast<int>(ctx.model->images.size())) {
				return -1;
			}

			if (auto it = ctx.texture_map.find(image_index); it != ctx.texture_map.end()) {
				return it->second;
			}

			const auto& img = ctx.model->images[image_index];
			if (img.width <= 0 || img.height <= 0 || img.image.empty()) return -1;

			FSurroundModelTexture tex;
			tex.width = img.width;
			tex.height = img.height;
			tex.rgba.resize(static_cast<size_t>(img.width) * img.height * 4, 255);
			const int comp = img.component;
			for (size_t p = 0; p < static_cast<size_t>(img.width) * img.height; ++p) {
				for (int c = 0; c < std::min(comp, 4); ++c) {
					tex.rgba[p * 4 + c] = img.image[p * comp + c];
				}
			}

			const int index = static_cast<int>(ctx.out->textures.size());
			ctx.out->textures.push_back(std::move(tex));
			ctx.texture_map[image_index] = index;
			return index;
		}

		bool bake_primitive(FBakeContext& ctx, const tinygltf::Primitive& prim, const glm::mat4& world) {
			if (prim.mode != TINYGLTF_MODE_TRIANGLES && prim.mode != -1) return true;

			auto attr = prim.attributes.find("POSITION");
			if (attr == prim.attributes.end()) return true;

			std::vector<float> positions;
			if (!read_accessor(*ctx.model, attr->second, 3, positions)) {
				ctx.error = "bad POSITION accessor";
				return false;
			}

			std::vector<float> normals;
			if (auto n = prim.attributes.find("NORMAL"); n != prim.attributes.end()) {
				read_accessor(*ctx.model, n->second, 3, normals);
			}
			std::vector<float> uvs;
			if (auto t = prim.attributes.find("TEXCOORD_0"); t != prim.attributes.end()) {
				read_accessor(*ctx.model, t->second, 2, uvs);
			}

			std::vector<uint32_t> indices;
			if (prim.indices >= 0) {
				if (!read_indices(*ctx.model, prim.indices, indices)) {
					ctx.error = "bad indices accessor";
					return false;
				}
			}
			else {
				indices.resize(positions.size() / 3);
				for (size_t i = 0; i < indices.size(); ++i) indices[i] = static_cast<uint32_t>(i);
			}
			if (indices.size() < 3) return true;

			auto& verts = ctx.out->vertices;
			const size_t first_vertex = verts.size() / SURROUND_MODEL_STRIDE;
			if (first_vertex + indices.size() > MODEL_MAX_VERTICES) {
				ctx.error = "model is too heavy: over "
					+ std::to_string(MODEL_MAX_VERTICES) + " vertices";
				return false;
			}

			FSurroundModelPrimitive out_prim;
			out_prim.first = static_cast<int>(first_vertex);
			out_prim.count = static_cast<int>((indices.size() / 3) * 3);
			out_prim.texture = bake_texture(ctx, prim.material, out_prim.base_color);

			const glm::mat3 normal_m = glm::mat3(glm::transpose(glm::inverse(world)));
			const size_t vertex_count = positions.size() / 3;

			// Индексы разворачиваются в суп треугольников: буфер один, без EBO
			for (size_t i = 0; i + 2 < indices.size(); i += 3) {
				glm::vec3 p[3];
				for (int k = 0; k < 3; ++k) {
					const uint32_t idx = indices[i + k];
					if (idx >= vertex_count) { ctx.error = "index out of range"; return false; }
					const glm::vec4 world_p = world * glm::vec4(
						positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2], 1.0f);
					p[k] = glm::vec3(world_p);
				}
				// Нет нормалей в файле - плоская по грани
				const glm::vec3 flat = glm::normalize(glm::cross(p[1] - p[0], p[2] - p[0]));

				for (int k = 0; k < 3; ++k) {
					const uint32_t idx = indices[i + k];
					glm::vec3 n = flat;
					if (idx * 3 + 2 < normals.size()) {
						n = glm::normalize(normal_m * glm::vec3(
							normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2]));
					}
					verts.push_back(p[k].x);
					verts.push_back(p[k].y);
					verts.push_back(p[k].z);
					verts.push_back(n.x);
					verts.push_back(n.y);
					verts.push_back(n.z);
					verts.push_back(idx * 2 + 1 < uvs.size() ? uvs[idx * 2] : 0.0f);
					verts.push_back(idx * 2 + 1 < uvs.size() ? uvs[idx * 2 + 1] : 0.0f);

					ctx.out->bbox_min = glm::min(ctx.out->bbox_min, p[k]);
					ctx.out->bbox_max = glm::max(ctx.out->bbox_max, p[k]);
				}
			}

			ctx.out->primitives.push_back(out_prim);
			return true;
		}

		bool bake_node(FBakeContext& ctx, int node_index, const glm::mat4& parent) {
			if (node_index < 0 || node_index >= static_cast<int>(ctx.model->nodes.size())) return true;
			const auto& node = ctx.model->nodes[node_index];
			const glm::mat4 world = parent * node_matrix(node);

			if (node.mesh >= 0 && node.mesh < static_cast<int>(ctx.model->meshes.size())) {
				for (const auto& prim : ctx.model->meshes[node.mesh].primitives) {
					if (!bake_primitive(ctx, prim, world)) return false;
				}
			}
			for (const int child : node.children) {
				if (!bake_node(ctx, child, world)) return false;
			}
			return true;
		}

	} // namespace

	bool load_surround_model(
		const std::filesystem::path& path,
		FSurroundModel& out,
		std::string& error)
	{
		tinygltf::Model model;
		tinygltf::TinyGLTF loader;
		std::string warn;

		if (!loader.LoadBinaryFromFile(&model, &error, &warn, path.string())) {
			if (error.empty()) error = "cannot parse glb";
			return false;
		}

		out = FSurroundModel{};
		out.bbox_min = glm::vec3(std::numeric_limits<float>::max());
		out.bbox_max = glm::vec3(std::numeric_limits<float>::lowest());

		FBakeContext ctx;
		ctx.model = &model;
		ctx.out = &out;

		const int scene_index = model.defaultScene >= 0 ? model.defaultScene : 0;
		if (scene_index >= static_cast<int>(model.scenes.size())) {
			error = "glb has no scenes";
			return false;
		}
		for (const int node : model.scenes[scene_index].nodes) {
			if (!bake_node(ctx, node, glm::mat4(1.0f))) {
				error = ctx.error.empty() ? "bake failed" : ctx.error;
				return false;
			}
		}

		if (out.vertices.empty()) {
			error = "glb has no triangles";
			return false;
		}
		return true;
	}

} // birdview
} // varan
