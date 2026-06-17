cmake_minimum_required(VERSION 3.18.1)

# 强制静态链接 libc++（NDK r18+ 使用 c++_static，非 gnustl 的 -static-libstdc++）
set(ANDROID_STL c++_static)

project("kctrl")

# 设置C++标准
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 设置编译选项
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Wextra -O2")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -O2")

# 添加可执行文件
add_executable(kctrl kctrl.cpp
        scenexec.cpp)
add_executable(opxiii opxiii.cpp)

# 链接Android库
find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(kctrl
    ${log-lib}
    ${android-lib}
    -static-libc++
)

target_link_libraries(opxiii
    ${log-lib}
    ${android-lib}
    -static-libc++
)

# 设置目标属性
set_target_properties(kctrl PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

set_target_properties(opxiii PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

# 添加编译定义
target_compile_definitions(kctrl PRIVATE
    ANDROID_NDK
)

target_compile_definitions(opxiii PRIVATE
    ANDROID_NDK
)

# 包含头文件目录
target_include_directories(kctrl PRIVATE
    ${ANDROID_NDK}/sysroot/usr/include
    ${ANDROID_NDK}/sysroot/usr/include/linux
)

target_include_directories(opxiii PRIVATE
    ${ANDROID_NDK}/sysroot/usr/include
    ${ANDROID_NDK}/sysroot/usr/include/linux
)