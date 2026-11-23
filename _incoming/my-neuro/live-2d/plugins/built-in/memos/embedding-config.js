function buildBackendEmbeddingConfig(cfg, backendCfg) {
    const be = cfg && cfg.backend_embedding;
    if (!be) return backendCfg;
    const provider = be.provider === 'api' ? 'api' : 'local';
    const baseUrl = String(be.api_base_url || 'https://api.siliconflow.cn/v1').trim();
    const apiKey = String(be.api_key || '').trim();
    backendCfg.embedding = backendCfg.embedding || {};
    backendCfg.embedding.provider = provider;
    backendCfg.embedding.use_api = provider === 'api';
    backendCfg.embedding.api_model = String(be.embedding_model || 'BAAI/bge-m3').trim();
    backendCfg.embedding.api = {
        ...(backendCfg.embedding.api || {}),
        base_url: baseUrl,
        model: String(be.embedding_model || 'BAAI/bge-m3').trim(),
        api_key: apiKey
    };
    backendCfg.search = backendCfg.search || {};
    // 2026-11-23 B4：重排序不再跟着嵌入走。
    // 嵌入端（8090）只有 /v1/embeddings，没有 /v1/rerank（实测 501）；以前这里把
    // reranker_provider 设成 api、model 设成 qwen3-embed，于是插件每次启动同步都会把
    // 「一开必失败」的配置写回去。现在只有显式配置了独立 rerank 端点才走 api。
    const rerankBase = String(be.rerank_api_base_url || '').trim();
    if (be.reranker_provider === 'api' && rerankBase) {
        backendCfg.search.reranker_provider = 'api';
        backendCfg.search.reranker_api = {
            ...(backendCfg.search.reranker_api || {}),
            base_url: rerankBase,
            model: String(be.rerank_model || 'BAAI/bge-reranker-v2-m3').trim(),
            api_key: String(be.rerank_api_key || apiKey).trim()
        };
    } else {
        backendCfg.search.reranker_provider = 'local';
        // 不保留旧 api 端点：否则「改回 local」之后残留配置仍会被当成可用
        if (!rerankBase) delete backendCfg.search.reranker_api;
    }
    return backendCfg;
}

module.exports = { buildBackendEmbeddingConfig };
