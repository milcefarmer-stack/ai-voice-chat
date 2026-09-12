/// <reference lib="dom" />

/** vendor 脚本注入的全局(vad-web,经 /vendor 挂载加载) */
interface MicVADOptions {
  model: string;
  baseAssetPath: string;
  onnxWASMBasePath: string;
  onSpeechStart: () => void;
  onSpeechRealStart: () => void;
  onVADMisfire: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onError: (e: unknown) => void;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
}

interface MicVADInstance {
  start(): void;
  pause(): void;
}

declare global {
  interface Window {
    vad: {
      // vad-web 的 MicVAD 类,静态工厂方法 new()(引号避免与构造签名冲突)
      MicVAD: {
        "new"(options: MicVADOptions): Promise<MicVADInstance>;
      };
    };
  }
}

export {};
