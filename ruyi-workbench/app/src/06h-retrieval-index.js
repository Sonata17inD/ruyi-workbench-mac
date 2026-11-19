// Retrieval owns its corpus and vocabulary caches; consumers hold separate instances.
const { createRetrievalCorpusCache, rankRetrievalCorpus, reciprocalRankFusion, retrievalTerms } = require('./backend/retrieval-index.cjs');
