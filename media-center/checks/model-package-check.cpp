// Чтение весов из контейнера .rjdm; фикстуры делает run-model-package-check.sh питоновским zipfile
// usage: model-package-check <dir>   (в dir: good.rjdm, deflated.rjdm, comment.rjdm, only-manifest.rjdm, weights.bin)

#include <cstdio>
#include <string>

#include "neural/model-package.h"

using namespace varan::neural;

static int failed = 0;

static void check(bool ok, const char* what) {
	std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
	if (!ok) ++failed;
}

int main(int argc, char** argv) {
	if (argc < 2) {
		std::fprintf(stderr, "usage: model-package-check <dir>\n");
		return 2;
	}
	const std::string dir = std::string(argv[1]) + "/";
	const auto expected = load_model(dir + "weights.bin");
	check(!expected.empty(), "fixture weights.bin is readable");

	check(is_model_package("/models/a.rjdm") && !is_model_package("/models/a.rknn") && !is_model_package("rjdm"), "extension check");
	check(load_model_weights(dir + "good.rjdm") == expected, "weights from a package equal the source file");
	check(load_package_weights(dir + "comment.rjdm") == expected, "archive with a comment and extra field");
	check(load_model_weights(dir + "weights.bin") == expected, "bare model goes through load_model");
	check(load_package_weights(dir + "deflated.rjdm").empty(), "compressed weights are rejected");
	check(load_package_weights(dir + "only-manifest.rjdm").empty(), "archive without weights.rknn is rejected");
	check(load_package_weights(dir + "weights.bin").empty(), "non-archive is rejected");
	check(load_package_weights(dir + "absent.rjdm").empty(), "missing file is rejected");
	return failed == 0 ? 0 : 1;
}
