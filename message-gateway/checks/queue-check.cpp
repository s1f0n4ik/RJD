#include "gateway/modules/modbus/queue.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "FAIL %d: %s\n", __LINE__, #value); std::exit(1); } } while (0)

int main() {
    char directory[] = "/tmp/gateway-queue-check-XXXXXX";
    CHECK(mkdtemp(directory));
    const auto parent = std::filesystem::path(directory) / "missing";
    const auto path = (parent / "queue.bin").string();
    varan::gateway::UModbusQueue queue(path);
    varan::gateway::FModbusRecord record;
    record.regs = {1, 2, 3};
    record.regs[1] = queue.push(record);
    CHECK(!queue.flush());
    std::filesystem::create_directory(parent);
    CHECK(queue.flush());
    varan::gateway::UModbusQueue restored(path);
    CHECK(restored.snapshot().total == 1);
    CHECK(restored.snapshot().head->regs == record.regs);
    std::puts("gateway queue-check: OK");
}
