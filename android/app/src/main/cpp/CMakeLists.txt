cmake_minimum_required(VERSION 3.22.1)
project(filterpod_whisper)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# whisper.cpp is vendored rather than pulled from a package manager: there is no
# maintained Android artifact, and we need control over the build flags below.
# Run `./gradlew vendorWhisper` (or scripts/vendor-whisper.sh) to populate this.
set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp)

if(NOT EXISTS ${WHISPER_DIR}/CMakeLists.txt)
    message(FATAL_ERROR
        "whisper.cpp is missing from ${WHISPER_DIR}.\n"
        "Run scripts/vendor-whisper.sh from the repo root before building.")
endif()

# We only need the library; the CLI examples and tests just slow the build down.
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)

# OpenMP off, for 16 KB page-size compatibility rather than performance.
#
# Android 15+ devices (including the Pixel 7 Pro this was tested on) use 16 KB memory
# pages, and Play requires 16 KB-aligned native libraries for apps targeting Android 15+.
# ggml's OpenMP path pulls in the NDK's prebuilt libomp.so, which is not aligned and
# which we cannot relink. ggml has its own thread pool and whisper.cpp drives it through
# the same `n_threads`, so dropping OpenMP removes the offending library at no cost.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

# Cross-compiling, so ggml must not probe the build host's CPU.
#
# The arch flags are deliberately left to ggml. An explicit
# `GGML_CPU_ARM_ARCH=armv8.2-a+dotprod` was rejected by clang ("unknown target CPU") and
# silently fell back, so it bought nothing; ggml's own defaults are tested against the
# NDK and already enable dotprod where the target supports it.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

add_subdirectory(${WHISPER_DIR} ${CMAKE_CURRENT_BINARY_DIR}/whisper EXCLUDE_FROM_ALL)

add_library(filterpod_whisper SHARED whisper_jni.cpp)

target_link_libraries(filterpod_whisper
    whisper
    android
    log)

target_compile_options(filterpod_whisper PRIVATE -O3 -ffast-math)

# Align LOAD segments to 16 KB. NDK r28 does this by default; r27 (used here) does not,
# and without it the loader reports "LOAD segment not aligned" on 16 KB-page devices.
target_link_options(filterpod_whisper PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384")
