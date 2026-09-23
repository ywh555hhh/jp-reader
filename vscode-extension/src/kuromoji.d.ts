// kuromoji 类型声明（npm 包未带类型）
declare module 'kuromoji' {
  export interface KuromojiToken {
    word_id: number;
    word_type: string;
    word_position: number;
    surface_form: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    basic_form: string;
    reading: string;
    pronunciation: string;
  }

  export interface Tokenizer {
    tokenize(text: string): KuromojiToken[];
  }

  export interface Builder {
    build(callback: (err: Error | null, tokenizer: Tokenizer) => void): void;
  }

  export function builder(options: { dicPath: string }): Builder;
}
