#include <iostream>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <vector>
#include <string>
#include <zlib.h>  // 用于 CRC32 校验

namespace fs = std::filesystem;

const std::string BASE_DIR = "/data/adb/modules/kctrl";
const std::string CONFIG_FILE = BASE_DIR + "/config.txt";
const std::string SCRIPT_DIR = BASE_DIR + "/scripts";
const std::string SLOT_DIR = BASE_DIR + "/slots";
const std::string SLOT_INFO = BASE_DIR + "/slot.info";

// ---------- 工具函数 ----------
std::string readFile(const fs::path& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return "";
    std::ostringstream oss; oss << ifs.rdbuf();
    return oss.str();
}

void writeFile(const fs::path& path, const std::string& content) {
    fs::create_directories(path.parent_path());
    std::ofstream ofs(path, std::ios::binary);
    if (!ofs) throw std::runtime_error("Cannot write: " + path.string());
    ofs.write(content.data(), content.size());
}

uint32_t calcCRC32(const std::string& data) {
    return crc32(0L, reinterpret_cast<const Bytef*>(data.data()), data.size());
}

// ---------- 打包 ----------
void pack(const std::string& outFile) {
    std::ofstream ofs(outFile, std::ios::binary);
    if (!ofs) throw std::runtime_error("Cannot create file: " + outFile);

    std::vector<fs::path> files;
    files.push_back(CONFIG_FILE);
    for (auto& p : fs::recursive_directory_iterator(SCRIPT_DIR))
        if (fs::is_regular_file(p)) files.push_back(p.path());

    uint32_t count = files.size();
    ofs.write(reinterpret_cast<char*>(&count), sizeof(count));

    for (auto& f : files) {
        std::string relPath = f.string();
        if (relPath.find(BASE_DIR + "/") == 0)
            relPath = relPath.substr(BASE_DIR.size() + 1);

        std::string content = readFile(f);
        uint32_t plen = relPath.size();
        uint32_t clen = content.size();
        uint32_t crc = calcCRC32(content);

        ofs.write(reinterpret_cast<char*>(&plen), sizeof(plen));
        ofs.write(relPath.data(), plen);
        ofs.write(reinterpret_cast<char*>(&clen), sizeof(clen));
        ofs.write(reinterpret_cast<char*>(&crc), sizeof(crc));
        ofs.write(content.data(), clen);
    }
}

// ---------- 解包 ----------
void unpack(const std::string& inFile) {
    std::ifstream ifs(inFile, std::ios::binary);
    if (!ifs) throw std::runtime_error("Cannot open: " + inFile);

    auto safeRead = [&](char* buf, size_t len) {
        ifs.read(buf, len);
        if (!ifs) throw std::runtime_error("Unexpected EOF");
    };

    uint32_t count = 0;
    safeRead(reinterpret_cast<char*>(&count), sizeof(count));
    if (count == 0 || count > 10000)
        throw std::runtime_error("Invalid file count in archive");

    std::cout << "[*] Unpacking " << count << " files...\n";

    int success = 0, failed = 0;

    for (uint32_t i = 0; i < count; i++) {
        try {
            uint32_t plen, clen, crcStored;
            safeRead(reinterpret_cast<char*>(&plen), sizeof(plen));

            if (plen == 0 || plen > 4096)
                throw std::runtime_error("Invalid path length");

            std::string relPath(plen, '\0');
            safeRead(&relPath[0], plen);
            safeRead(reinterpret_cast<char*>(&clen), sizeof(clen));
            safeRead(reinterpret_cast<char*>(&crcStored), sizeof(crcStored));

            if (clen > 100 * 1024 * 1024)
                throw std::runtime_error("Invalid content length");

            std::string content(clen, '\0');
            safeRead(&content[0], clen);

            uint32_t crcCalc = calcCRC32(content);
            if (crcCalc != crcStored)
                throw std::runtime_error("CRC mismatch for " + relPath);

            fs::path fullPath = fs::path(BASE_DIR) / relPath;
            writeFile(fullPath, content);

            std::cout << " [+] Restored: " << relPath << std::endl;
            success++;
        } catch (const std::exception& e) {
            std::cerr << " [!] Skipping file #" << (i + 1) << ": " << e.what() << std::endl;
            failed++;
            ifs.clear();
        }
    }

    std::cout << "\n[✓] Done. Restored " << success << " files, "
              << failed << " failed.\n";
}

// ---------- 槽位 ----------
std::string readSlotInfo() { return readFile(SLOT_INFO); }
void writeSlotInfo(const std::string& id) { writeFile(SLOT_INFO, id); }

void saveSlot(const std::string& id) {
    fs::create_directories(SLOT_DIR);
    std::string savePath = SLOT_DIR + "/slot_" + id + ".bin";
    pack(savePath);
    writeSlotInfo(id);
    std::cout << "[+] Saved current config as slot: " << id << std::endl;
}

void switchConfig(const std::string& id) {
    fs::create_directories(SLOT_DIR);
    std::string current = readSlotInfo();

    if (!current.empty()) {
        std::string savePath = SLOT_DIR + "/slot_" + current + ".bin";
        pack(savePath);
        std::cout << "[+] Saved current slot: " << current << std::endl;
    }

    std::string targetPath = SLOT_DIR + "/slot_" + id + ".bin";
    if (!fs::exists(targetPath)) {
        std::cerr << "[-] Target slot not found: " << targetPath << std::endl;
        return;
    }

    unpack(targetPath);
    writeSlotInfo(id);
    std::cout << "[+] Switched to slot: " << id << std::endl;
}

void listSlots() {
    std::string current = readSlotInfo();
    std::cout << "=== Slots List ===" << std::endl;
    if (!fs::exists(SLOT_DIR)) {
        std::cout << "(empty)" << std::endl;
        return;
    }
    for (auto& p : fs::directory_iterator(SLOT_DIR)) {
        if (p.is_regular_file()) {
            std::string fname = p.path().filename().string();
            if (fname.rfind("slot_", 0) == 0 && fname.find(".bin") != std::string::npos) {
                std::string id = fname.substr(5, fname.size() - 9);
                if (id == current)
                    std::cout << " * " << id << " (current)" << std::endl;
                else
                    std::cout << "   " << id << std::endl;
            }
        }
    }
}

// ---------- 主函数 ----------
int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage:\n"
                  << "  pk [file]\n"
                  << "  up [file]\n"
                  << "  sc save [id]\n"
                  << "  sc [id]\n"
                  << "  sc list\n";
        return 1;
    }

    std::string cmd = argv[1];
    try {
        if (cmd == "pk" && argc >= 3) {
            pack(argv[2]);
        } else if (cmd == "up" && argc >= 3) {
            unpack(argv[2]);
        } else if (cmd == "sc") {
            if (argc == 3 && std::string(argv[2]) == "list") {
                listSlots();
            } else if (argc == 4 && std::string(argv[2]) == "save") {
                saveSlot(argv[3]);
            } else if (argc == 3) {
                switchConfig(argv[2]);
            } else {
                std::cerr << "Usage:\n"
                          << "  sc save [id]\n"
                          << "  sc [id]\n"
                          << "  sc list\n";
            }
        } else {
            std::cerr << "Invalid arguments.\n";
            return 1;
        }
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
