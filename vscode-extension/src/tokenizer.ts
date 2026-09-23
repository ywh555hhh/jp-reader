import * as kuromoji from 'kuromoji';

/**
 * kuromoji 离线分词封装（带缓存）。
 *
 * 本模块**不持有任何状态**：缓存由调用方（appContext）创建并持有唯一一份。
 * 这样"当前用的是哪个 tokenizer"只有一个持有者（否命题 A10）。
 *
 * 用工厂而不是模块级 let 的另一个好处：测试可以造一个互不干扰的实例。
 */

export interface TokenizerCache {
    /** 取分词器（必要时构建；并发调用共享同一次构建） */
    get(dicPath: string): Promise<kuromoji.Tokenizer>;
    /** 已就绪的分词器（未就绪返回 null）——渲染路径用它，避免在渲染里 await 构建 */
    ready(): kuromoji.Tokenizer | null;
}

export function createTokenizerCache(): TokenizerCache {
    let cached: kuromoji.Tokenizer | null = null;
    let building: Promise<kuromoji.Tokenizer> | null = null;

    return {
        get(dicPath: string): Promise<kuromoji.Tokenizer> {
            if (cached) {
                return Promise.resolve(cached);
            }
            if (building) {
                return building;
            }
            building = new Promise<kuromoji.Tokenizer>((resolve, reject) => {
                kuromoji.builder({ dicPath }).build((err, tokenizer) => {
                    if (err || !tokenizer) {
                        reject(err || new Error('kuromoji 构建失败'));
                        return;
                    }
                    cached = tokenizer;
                    resolve(tokenizer);
                });
            });
            return building;
        },
        ready(): kuromoji.Tokenizer | null {
            return cached;
        },
    };
}
