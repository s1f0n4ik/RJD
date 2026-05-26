#pragma once

#include "utility/json-reader.h"

namespace varan {
namespace calibration {

	/*
		Индекс GL-готовых stitching-экспортов.

		{
			"<id>": {
				"name":   "Test 360 на кубе",
				"width":  750,
				"height": 750,
				"cameras": {
					"front":  { "remap": "test_3cam/front_remap.bin",  "weight": "test_3cam/front_weight.bin" },
					"right":  { "remap": "test_3cam/right_remap.bin",  "weight": "test_3cam/right_weight.bin" },
					"left":   { "remap": "test_3cam/left_remap.bin",   "weight": "test_3cam/left_weight.bin" }
				}
			}
		}
	*/
	class UJsonStitchingExports : public UJsonReaderBase {
	public:
		explicit UJsonStitchingExports(ULogger* logger = nullptr)
			: UJsonReaderBase(logger) {}

	protected:
		std::string class_tag() const override { return "UJsonStitchingExports "; }

		const std::unordered_set<std::string>& allowed_fields() const override {
			static const std::unordered_set<std::string> fields = {
				"name", "width", "height", "cameras"
			};
			return fields;
		}
	};

} // namespace calibration
} // namespace varan