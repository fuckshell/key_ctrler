#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <vector>
#include <unistd.h>
#include <sys/utsname.h>

// 简单的 XOR 加密
std::string xorEncrypt(const std::string& input, const std::string& key) {
    std::string output = input;
    for (size_t i = 0; i < input.size(); i++) {
        output[i] ^= key[i % key.size()];
    }
    return output;
}

// Base64 编码表
static const std::string base64_chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789+/";

std::string base64Encode(const std::string& bytes_to_encode) {
    std::string ret;
    int val = 0, valb = -6;
    for (unsigned char c : bytes_to_encode) {
        val = (val << 8) + c;
        valb += 8;
        while (valb >= 0) {
            ret.push_back(base64_chars[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) ret.push_back(base64_chars[((val << 8) >> (valb + 8)) & 0x3F]);
    while (ret.size() % 4) ret.push_back('=');
    return ret;
}

// 读取文件内容
std::string readFile(const std::string& path) {
    std::ifstream ifs(path);
    if (!ifs.is_open()) return "[ERROR] Cannot open " + path + "\n";
    std::stringstream buffer;
    buffer << ifs.rdbuf();
    return buffer.str();
}

// 获取时间戳
std::string getTimestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&t), "%Y-%m-%d %H:%M:%S");
    return ss.str();
}

// 获取设备标识
std::string getDeviceInfo() {
    struct utsname sysinfo;
    uname(&sysinfo);

    std::stringstream ss;
    ss << "Sysname: " << sysinfo.sysname << "\n"
       << "Nodename: " << sysinfo.nodename << "\n"
       << "Release: " << sysinfo.release << "\n"
       << "Version: " << sysinfo.version << "\n"
       << "Machine: " << sysinfo.machine << "\n";

    // 获取进程ID
    ss << "PID: " << getpid() << "\n";

    return ss.str();
}

int main() {
    std::string config = readFile("/data/adb/modules/kctrl/config.txt");
    std::string klog   = readFile("/data/adb/modules/kctrl/klog.log");

    std::stringstream combined;
    combined << "=== Device Info ===\n" << getDeviceInfo()
             << "\n=== Timestamp ===\n" << getTimestamp()
             << "\n=== Config.txt ===\n" << config
             << "\n=== Klog.log ===\n"   << klog;

    std::string rawData = combined.str();

    // 加密：先 XOR，再 Base64
    std::string encrypted = xorEncrypt(rawData, "MySecretKey123");
    std::string encoded   = base64Encode(encrypted);

    // 写文件
    std::ofstream ofs("/data/adb/modules/kctrl/bugdump.txt");
    if (ofs.is_open()) {
        ofs << encoded;
        ofs.close();
        std::cout << "Bugdump written to /data/adb/modules/kctrl/bugdump.txt\n";
    } else {
        std::cerr << "Failed to write bugdump.txt\n";
        return 1;
    }

    return 0;
}
