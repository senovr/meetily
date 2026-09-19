# whisper-rs-sys forwards CMAKE_* variables, so inject this after project().
# Avoid specializing native code for the CI runner; the x64 baseline retains AVX2.
set(GGML_NATIVE OFF CACHE BOOL "Build without host CPU specialization" FORCE)

# CUDA 13 removed the Maxwell/Pascal targets (sm_50/52/53/60/61/62), but
# whisper.cpp's default architecture list still includes 52 and 61 — nvcc 13+
# aborts with "Unsupported gpu architecture 'compute_52'". ggml only assigns
# CMAKE_CUDA_ARCHITECTURES when it is undefined, so a cache FORCE here wins.
# CI sets MEETILY_CUDA_ARCH per matrix leg:
#   standard  legs: broad multi-arch (Turing..Blackwell + PTX for the future)
#   optimized legs: fleet-pinned sm86/sm89 (RTX 3070 / RTX 4000 Ada) + PTX
if(DEFINED ENV{MEETILY_CUDA_ARCH})
    set(CMAKE_CUDA_ARCHITECTURES "$ENV{MEETILY_CUDA_ARCH}" CACHE STRING "CUDA architectures" FORCE)
else()
    set(CMAKE_CUDA_ARCHITECTURES "80;86;89;90;90-virtual" CACHE STRING "CUDA architectures" FORCE)
endif()

# CUDA 13's CCCL (cub/thrust) refuses C++14 device/host dialects — the build
# must target C++17 for the CUDA language while ggml's C++ side stays as-is.
set(CMAKE_CUDA_STANDARD 17 CACHE STRING "CUDA C++ standard" FORCE)

# CUDA 13's CCCL headers (#error in cccl/preprocessor.h) refuse MSVC's
# traditional preprocessor. nvcc forwards the flag to cl.exe host passes via
# -Xcompiler; generator-expression scoping keeps it off plain C/C++ targets
# (cl there already gets /Zc from the standard MSVC toolchain flags).
add_compile_options("$<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=/Zc:preprocessor>")
