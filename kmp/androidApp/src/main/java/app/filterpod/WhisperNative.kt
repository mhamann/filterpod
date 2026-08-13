package app.filterpod

/** Thin JNI surface over whisper.cpp. See src/main/cpp/whisper_jni.cpp. */
object WhisperNative {
    init {
        System.loadLibrary("filterpod_whisper")
    }

    /** Returns a context pointer, or 0 on failure. */
    external fun initContext(modelPath: String): Long

    external fun freeContext(ptr: Long)

    /**
     * Transcribes 16kHz mono PCM.
     * Returns a flat `word, startMs, endMs` triple array, or null on failure.
     */
    external fun transcribe(ptr: Long, pcm: FloatArray, threads: Int): Array<String>?
}
