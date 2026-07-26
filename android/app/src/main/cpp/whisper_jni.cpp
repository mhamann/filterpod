/**
 * JNI bridge to whisper.cpp.
 *
 * Exposes just enough for FilterPod's needs: load a model, transcribe a span of 16kHz
 * mono PCM, and return words with timings. Word-level timing is the whole point — cue
 * or segment granularity cannot locate a single word to cut — so token timestamps are
 * enabled and `max_len = 1` forces one token per segment.
 */

#include <jni.h>
#include <string>
#include <vector>
#include <android/log.h>

#include "whisper.h"

#define LOG_TAG "FilterPodWhisper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jlong JNICALL
Java_app_filterpod_WhisperNative_initContext(JNIEnv *env, jobject, jstring modelPath) {
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    whisper_context_params params = whisper_context_default_params();
    // GPU offload is unreliable across the Android device fleet; CPU is the safe default.
    params.use_gpu = false;

    whisper_context *ctx = whisper_init_from_file_with_params(path, params);
    env->ReleaseStringUTFChars(modelPath, path);

    if (ctx == nullptr) {
        LOGE("failed to initialize whisper context");
        return 0;
    }
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_app_filterpod_WhisperNative_freeContext(JNIEnv *, jobject, jlong ptr) {
    if (ptr != 0) {
        whisper_free(reinterpret_cast<whisper_context *>(ptr));
    }
}

/**
 * Transcribes [pcm] and returns a flat String array of
 * `word, startMs, endMs` triples — flat rather than a structured type because
 * marshalling one object array across JNI is markedly cheaper than per-word objects.
 */
JNIEXPORT jobjectArray JNICALL
Java_app_filterpod_WhisperNative_transcribe(
        JNIEnv *env, jobject, jlong ptr, jfloatArray pcm, jint threads) {

    auto *ctx = reinterpret_cast<whisper_context *>(ptr);
    if (ctx == nullptr) return nullptr;

    const jsize sampleCount = env->GetArrayLength(pcm);
    jfloat *samples = env->GetFloatArrayElements(pcm, nullptr);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_realtime = false;
    params.print_progress = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.translate = false;
    params.language = "en";
    params.n_threads = threads;

    // One token per segment, with timestamps, gives word-level granularity.
    params.token_timestamps = true;
    params.max_len = 1;
    params.split_on_word = true;
    // No point transcribing silence; it only costs time.
    params.no_context = true;
    params.suppress_blank = true;

    const int result = whisper_full(ctx, params, samples, sampleCount);
    env->ReleaseFloatArrayElements(pcm, samples, JNI_ABORT);

    if (result != 0) {
        LOGE("whisper_full failed with %d", result);
        return nullptr;
    }

    const int segments = whisper_full_n_segments(ctx);
    std::vector<std::string> flat;
    flat.reserve(segments * 3);

    for (int i = 0; i < segments; i++) {
        const char *text = whisper_full_get_segment_text(ctx, i);
        if (text == nullptr) continue;

        // whisper.cpp timestamps are in centiseconds.
        const int64_t startMs = whisper_full_get_segment_t0(ctx, i) * 10;
        const int64_t endMs = whisper_full_get_segment_t1(ctx, i) * 10;

        flat.emplace_back(text);
        flat.emplace_back(std::to_string(startMs));
        flat.emplace_back(std::to_string(endMs));
    }

    jclass stringClass = env->FindClass("java/lang/String");
    jobjectArray out = env->NewObjectArray(
            static_cast<jsize>(flat.size()), stringClass, nullptr);

    for (size_t i = 0; i < flat.size(); i++) {
        jstring value = env->NewStringUTF(flat[i].c_str());
        env->SetObjectArrayElement(out, static_cast<jsize>(i), value);
        env->DeleteLocalRef(value);
    }

    return out;
}

}  // extern "C"
