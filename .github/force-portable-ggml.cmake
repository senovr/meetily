# whisper-rs-sys forwards CMAKE_* variables, so inject this after project().
# Avoid specializing native code for the CI runner; the x64 baseline retains AVX2.
set(GGML_NATIVE OFF CACHE BOOL "Build without host CPU specialization" FORCE)

# CUDA 13 removed the Maxwell/Pascal targets (sm_50/52/53/60/61/62), but
# whisper.cpp's default architecture list still includes 52 and 61 — nvcc 13+
# aborts with "Unsupported gpu architecture 'compute_52'". ggml only assigns
# CMAKE_CUDA_ARCHITECTURES when it is undefined, so a cache FORCE here wins:
# Ampere/Turing/Ada/Hopper fatbins plus embedded PTX (90-virtual) that the
# driver can JIT for anything newer.
set(CMAKE_CUDA_ARCHITECTURES "80;86;89;90;90-virtual" CACHE STRING "CUDA architectures" FORCE)
