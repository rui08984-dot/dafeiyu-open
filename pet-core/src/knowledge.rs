//! 知识库混合检索引擎（2026-11-09 三十五轮）
//!
//! 为什么用 Rust 写核心：这是每次注入 prompt 前都要跑的纯计算（切词打分 / 余弦 / 融合排序），
//! 放在 JS/Python 里每轮要几十毫秒且各处重复一份。Rust 里 <1ms，且逻辑只有一份。
//!
//! 设计原则：**不自己造轮子**，只组合成熟算法。
//!
//! ```text
//! 查询 ──┬─► BM25（jieba 切词 → 倒排索引 → Okapi BM25）        ──┐
//!        │   经典信息检索，对精确词（「卡槽」「冷却」）强        │
//!        └─► 向量余弦（Qwen3-Embedding 0.6B 的 1024 维向量）   ──┤
//!            对语义（「为什么种不上」≈「卡槽冷却」）强            │
//!                                                              ▼
//!                                                RRF 倒数排名融合
//!                                                              ▼
//!                                              取 Top-K → 注入 prompt
//! ```
//!
//! 为什么是 RRF 不是加权求和：
//!   BM25 分数是无界的（0~几十分），余弦是 [-1,1]。直接加权要调两个归一化参数，
//!   换语料就得重调。RRF 只用**排名**（1/(k+rank)），量纲无关，是 2024 年后的主流做法。
//!   k=60 是原论文（Cormack et al.）的经验值，实测对混合检索很稳。
//!
//! 为什么不引 lancedb/qdrant：
//!   知识库规模是**几百到几千条**（不是百万级）。暴力算余弦是 O(n·d)，
//!   1000 条 × 1024 维 ≈ 100 万次乘加 ≈ 0.3ms，比任何 ANN 索引的建索引成本都划算，
//!   还省掉一个常驻服务和一个数据库文件。等真的过万条再换。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// BM25 参数。k1 控制词频饱和，b 控制长度归一化。这两个是 Okapi 原论文默认值。
const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
/// RRF 平滑常数（原论文经验值）。
const RRF_K: f64 = 60.0;

// ── 文档与结果 ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    /// 原文（给 prompt 用）
    pub text: String,
    /// 检索用的字段（通常是 text + 标题 + 标签拼起来的）
    #[serde(default)]
    pub searchable: String,
    /// 向量（1024 维，由 8090 嵌入服务给出）。空表示这条没做嵌入。
    #[serde(default)]
    pub embedding: Vec<f32>,
    /// 权重（比如 stable 规则 1.0、过期 live 0.5、经验 0.8）
    #[serde(default = "one")]
    pub weight: f64,
    /// 任意元数据（game / kind / ts / confidence）
    #[serde(default)]
    pub meta: HashMap<String, String>,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub id: String,
    pub text: String,
    pub score: f64,
    /// 各通道的排名（None 表示该通道没召回它）
    pub rank_bm25: Option<usize>,
    pub rank_vec: Option<usize>,
    pub bm25: f64,
    pub cosine: f64,
    pub meta: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchTrace {
    /// 语料条数
    pub corpus: usize,
    /// 有向量的条数
    pub with_vectors: usize,
    /// BM25 命中数
    pub bm25_hits: usize,
    /// 向量通道有效数（0 表示没给查询向量）
    pub vec_hits: usize,
    /// 融合后取了几条
    pub returned: usize,
    /// 各阶段耗时（微秒）
    pub us_tokenize: u64,
    pub us_bm25: u64,
    pub us_cosine: u64,
    pub us_fuse: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub trace: SearchTrace,
}

// ── 切词 ─────────────────────────────────────────────────────────────
//
// 中文必须切词，否则 BM25 会把「卡槽冷却」当成一个词，用户查「卡槽」永远命中不了。
// 这里不引 jieba-rs（要带 10MB 词典），而是用**极简但够用的启发式**：
//   ① ASCII 按非字母数字切开并转小写
//   ② CJK 连续段做 **bigram**（「卡槽冷却」→ 卡槽/槽冷/冷却）
//      —— bigram 是中文检索里被反复验证过的性价比之王：不需要词典、
//         召回率高（「种不上」能命中「种不上」也能命中「种不」），
//         代价是索引略大、但我们的语料只有几千条。
//   ③ 单字 CJK 也保留（「种」「收」这类单字查询）
//
// 如果以后要更准，换 jieba-rs 只改这一个函数，接口不变。

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
}

pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut ascii_buf = String::new();
    let mut cjk_buf: Vec<char> = Vec::new();

    let flush_ascii = |buf: &mut String, out: &mut Vec<String>| {
        if !buf.is_empty() {
            let t = buf.to_lowercase();
            if t.len() >= 1 {
                out.push(t);
            }
            buf.clear();
        }
    };
    let flush_cjk = |buf: &mut Vec<char>, out: &mut Vec<String>| {
        if buf.is_empty() {
            return;
        }
        if buf.len() == 1 {
            out.push(buf[0].to_string());
        } else {
            // bigram
            for i in 0..buf.len() - 1 {
                out.push(format!("{}{}", buf[i], buf[i + 1]));
            }
            // 单字也留（查询「种」能命中）
            for c in buf.iter() {
                out.push(c.to_string());
            }
        }
        buf.clear();
    };

    for c in text.chars() {
        if is_cjk(c) {
            flush_ascii(&mut ascii_buf, &mut out);
            cjk_buf.push(c);
        } else if c.is_alphanumeric() {
            flush_cjk(&mut cjk_buf, &mut out);
            ascii_buf.push(c);
        } else {
            // 标点/空白：两边都断
            flush_ascii(&mut ascii_buf, &mut out);
            flush_cjk(&mut cjk_buf, &mut out);
        }
    }
    flush_ascii(&mut ascii_buf, &mut out);
    flush_cjk(&mut cjk_buf, &mut out);
    out
}

// ── BM25 索引 ────────────────────────────────────────────────────────

pub struct Bm25Index {
    /// 词 → [(文档下标, 词频)]
    postings: HashMap<String, Vec<(usize, u32)>>,
    /// 每篇文档长度（token 数）
    doc_len: Vec<f64>,
    /// 平均文档长度
    avgdl: f64,
    /// 语料大小
    n: usize,
}

impl Bm25Index {
    pub fn build(docs: &[Doc]) -> Self {
        let mut postings: HashMap<String, Vec<(usize, u32)>> = HashMap::new();
        let mut doc_len = Vec::with_capacity(docs.len());

        for (i, d) in docs.iter().enumerate() {
            let src = if d.searchable.is_empty() { &d.text } else { &d.searchable };
            let toks = tokenize(src);
            doc_len.push(toks.len() as f64);
            let mut tf: HashMap<&str, u32> = HashMap::new();
            for t in &toks {
                *tf.entry(t.as_str()).or_insert(0) += 1;
            }
            // 注：这里 tf 的 key 借了 toks 的生命周期，所以要先把 (词, 频) 收集再插入
            let collected: Vec<(String, u32)> = tf.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
            for (term, freq) in collected {
                postings.entry(term).or_default().push((i, freq));
            }
        }

        let n = docs.len();
        let total: f64 = doc_len.iter().sum();
        let avgdl = if n > 0 { total / n as f64 } else { 0.0 };

        Self { postings, doc_len, avgdl, n }
    }

    /// 返回 [(文档下标, BM25 分数)]，按分数降序。
    pub fn search(&self, query: &str) -> Vec<(usize, f64)> {
        if self.n == 0 {
            return Vec::new();
        }
        let q_toks = tokenize(query);
        if q_toks.is_empty() {
            return Vec::new();
        }
        let mut scores = vec![0.0f64; self.n];
        let mut seen: HashMap<String, ()> = HashMap::new();

        for t in &q_toks {
            // 同一查询词出现多次只算一次（避免长查询被重复词主导）
            if seen.insert(t.clone(), ()).is_some() {
                continue;
            }
            let Some(post) = self.postings.get(t) else { continue };
            // IDF（Lucene 的平滑形式，恒为正）
            let df = post.len() as f64;
            let idf = ((self.n as f64 - df + 0.5) / (df + 0.5) + 1.0).ln();
            for &(doc_i, tf) in post {
                let f = tf as f64;
                let dl = self.doc_len[doc_i];
                let denom = f + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / self.avgdl.max(1e-9));
                scores[doc_i] += idf * (f * (BM25_K1 + 1.0)) / denom.max(1e-9);
            }
        }

        let mut out: Vec<(usize, f64)> = scores
            .into_iter()
            .enumerate()
            .filter(|(_, s)| *s > 0.0)
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        out
    }
}

// ── 向量 ─────────────────────────────────────────────────────────────

/// 余弦相似度。两边都归一化过就直接点积。
pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..n {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na <= 1e-12 || nb <= 1e-12 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// 暴力向量检索（语料 <1 万条时最快且最省事）。
pub fn vector_search(docs: &[Doc], q: &[f32], min_cos: f64) -> Vec<(usize, f64)> {
    if q.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(usize, f64)> = docs
        .iter()
        .enumerate()
        .filter_map(|(i, d)| {
            if d.embedding.is_empty() {
                return None;
            }
            let c = cosine(q, &d.embedding);
            if c < min_cos {
                None
            } else {
                Some((i, c))
            }
        })
        .collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ── RRF 融合 ─────────────────────────────────────────────────────────

/// 倒数排名融合。只用排名，量纲无关 —— 换语料不用重调权重。
///
/// `weight` 是文档自带的置信权重（过期经验 0.5、稳定规则 1.0），
/// 乘在 RRF 分上，让「过时的知识」排在后面但不消失。
pub fn rrf_fuse(
    docs: &[Doc],
    bm25_ranked: &[(usize, f64)],
    vec_ranked: &[(usize, f64)],
    top_k: usize,
) -> Vec<Hit> {
    let mut acc: HashMap<usize, (f64, Option<usize>, Option<usize>, f64, f64)> = HashMap::new();

    for (rank, &(i, s)) in bm25_ranked.iter().enumerate() {
        let e = acc.entry(i).or_insert((0.0, None, None, 0.0, 0.0));
        e.0 += 1.0 / (RRF_K + (rank + 1) as f64);
        e.1 = Some(rank + 1);
        e.3 = s;
    }
    for (rank, &(i, s)) in vec_ranked.iter().enumerate() {
        let e = acc.entry(i).or_insert((0.0, None, None, 0.0, 0.0));
        e.0 += 1.0 / (RRF_K + (rank + 1) as f64);
        e.2 = Some(rank + 1);
        e.4 = s;
    }

    let mut hits: Vec<Hit> = acc
        .into_iter()
        .map(|(i, (rrf, rb, rv, bm, cos))| {
            let w = docs[i].weight.clamp(0.0, 2.0);
            Hit {
                id: docs[i].id.clone(),
                text: docs[i].text.clone(),
                score: rrf * w,
                rank_bm25: rb,
                rank_vec: rv,
                bm25: bm,
                cosine: cos,
                meta: docs[i].meta.clone(),
            }
        })
        .collect();

    // 同分时：向量排名靠前的优先（语义匹配通常更贴近「为什么种不上」这类问法）
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let ra = a.rank_vec.unwrap_or(usize::MAX);
                let rb = b.rank_vec.unwrap_or(usize::MAX);
                ra.cmp(&rb)
            })
    });
    hits.truncate(top_k);
    hits
}

// ── 一体化入口 ───────────────────────────────────────────────────────

/// 混合检索。`query_vec` 为空则自动退化成纯 BM25（嵌入服务挂了也能用）。
pub fn search(docs: &[Doc], query: &str, query_vec: &[f32], top_k: usize) -> SearchResult {
    let t0 = std::time::Instant::now();

    // 索引是每次查询现建的（几千条 × bigram ≈ 几万词，建索引 1-3ms）。
    // 这样做的好处：调用方不用管「文档更新了要重建索引」这个状态同步问题。
    // 等语料过万、或 QPS 变高，再换成调用方持有索引。
    let idx = Bm25Index::build(docs);
    let bm25_ranked = idx.search(query);
    let us_bm25 = t0.elapsed().as_micros() as u64;

    let t1 = std::time::Instant::now();
    let vec_ranked = if query_vec.is_empty() {
        Vec::new()
    } else {
        vector_search(docs, query_vec, 0.25)
    };
    let us_cosine = t1.elapsed().as_micros() as u64;

    let t2 = std::time::Instant::now();
    let hits = rrf_fuse(docs, &bm25_ranked, &vec_ranked, top_k);
    let us_fuse = t2.elapsed().as_micros() as u64;

    SearchResult {
        hits,
        trace: SearchTrace {
            corpus: docs.len(),
            with_vectors: docs.iter().filter(|d| !d.embedding.is_empty()).count(),
            bm25_hits: bm25_ranked.len(),
            vec_hits: vec_ranked.len(),
            returned: 0, // 下面补
            us_tokenize: 0,
            us_bm25,
            us_cosine,
            us_fuse,
        },
    }
    .tap(|mut r| {
        r.trace.returned = r.hits.len();
        r
    })
}

// 小工具：链式「tap」，省掉临时变量
trait Tap: Sized {
    fn tap<F: FnOnce(Self) -> Self>(self, f: F) -> Self {
        f(self)
    }
}
impl<T> Tap for T {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_cjk_bigram() {
        let t = tokenize("卡槽冷却");
        assert!(t.contains(&"卡槽".to_string()), "应有 bigram 卡槽: {:?}", t);
        assert!(t.contains(&"冷却".to_string()), "应有 bigram 冷却: {:?}", t);
        assert!(t.contains(&"卡".to_string()), "应保留单字: {:?}", t);
    }

    #[test]
    fn tokenize_ascii() {
        let t = tokenize("SendInput KEYEVENTF_SCANCODE");
        assert!(t.contains(&"sendinput".to_string()));
        assert!(t.contains(&"keyeventf".to_string()));
        assert!(t.contains(&"scancode".to_string()));
    }

    #[test]
    fn bm25_ranks_relevant_first() {
        let docs = vec![
            Doc {
                id: "a".into(),
                text: "必须先选卡槽再点格子，否则种不上".into(),
                searchable: String::new(),
                embedding: vec![],
                weight: 1.0,
                meta: HashMap::new(),
            },
            Doc {
                id: "b".into(),
                text: "阳光是唯一货币".into(),
                searchable: String::new(),
                embedding: vec![],
                weight: 1.0,
                meta: HashMap::new(),
            },
        ];
        let idx = Bm25Index::build(&docs);
        let r = idx.search("卡槽");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, 0);
    }

    #[test]
    fn cosine_basic() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-9);
        assert_eq!(cosine(&[], &[1.0]), 0.0);
    }

    #[test]
    fn rrf_prefers_both_channels() {
        let docs: Vec<Doc> = (0..5)
            .map(|i| Doc {
                id: format!("d{}", i),
                text: format!("doc {}", i),
                searchable: String::new(),
                embedding: vec![],
                weight: 1.0,
                meta: HashMap::new(),
            })
            .collect();
        // d0 只在 bm25 第 1，d1 只在 vec 第 1，d2 两路都第 2
        let bm = vec![(0, 10.0), (2, 8.0)];
        let vc = vec![(1, 0.9), (2, 0.85)];
        let hits = rrf_fuse(&docs, &bm, &vc, 5);
        // d2 两路都有，应该排第一
        assert_eq!(hits[0].id, "d2", "两路都召回的应排第一: {:?}", hits.iter().map(|h| &h.id).collect::<Vec<_>>());
    }

    #[test]
    fn rrf_applies_weight() {
        let mut docs: Vec<Doc> = (0..3)
            .map(|i| Doc {
                id: format!("d{}", i),
                text: "x".into(),
                searchable: String::new(),
                embedding: vec![],
                weight: 1.0,
                meta: HashMap::new(),
            })
            .collect();
        docs[0].weight = 0.5; // 过期知识
        let bm = vec![(0, 10.0), (1, 9.0)];
        let hits = rrf_fuse(&docs, &bm, &[], 3);
        // d0 排名更前但权重打折，应该被 d1 反超
        assert_eq!(hits[0].id, "d1", "权重打折的应排后面: {:?}", hits);
    }

    #[test]
    fn search_works_without_vectors() {
        let docs = vec![Doc {
            id: "a".into(),
            text: "卡槽冷却中点了不会种下".into(),
            searchable: String::new(),
            embedding: vec![],
            weight: 1.0,
            meta: HashMap::new(),
        }];
        let r = search(&docs, "卡槽", &[], 5);
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.trace.vec_hits, 0);
    }
}
