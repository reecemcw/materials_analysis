# materials_analysis
This is a NodeJS app which intends to:

1. SCRAPE - Scrape targetted materials analysis publications (ethically, intentionally, permitted, rate-limited!)
2. STORE - Write scraped data to standardised format.
3. LABEL - Metatag the article objects with metatags to feed a RAG
4. CONTEXTUALISE - Compose the orticle objects and metadata as a knowledge graph to enable RAG.
5. SERVE - Serve a natural language query interface to a user, which maps their query into RAG, and returns a contextual, informative, accurate reponse with the help of an LLM service. 

| Seq | Feature | Description | Status |
| :--- | :--- | :--- | :--- |
| 1   | Scraper | Ethical scraping service which pulls article representation from target publishers | Initial Release |
| 2   | Article Object Write Service | Standardise format of article representations | Initial Release |
| 3   | Metatagging Service | Enhanced labelling of initial article representations which better enable the knowledge graph | Initial Release - Claude (tested) |
| 4   | Knowledge Graph | Knowlege graph schema which enables RAG on the article representations | IN PROGRESS |
| 5   | Front End | Simple web app with queriable text space | Initial Release |
| 6   | TESTING | E2E test | Initial Release |


The product allows users to effectively and efficiently query a large body of materials knowledge from varied sources via natural language, empowering their analysis workflows in the areas of risk, market intelligence and trading.

