## Paperec

Paperec adds paper rating and personalized recommendation to papers.cool.

#### Installation

Clone the repository and start the local server with one command: 

```bash
git clone https://github.com/gndlwch2w/paperec.git && \
 cd paperec && bash install.sh && \
 source .venv/bin/activate && bash run.sh
```

#### Client

Install `paperec.js` in Tampermonkey, then open any `https://papers.cool/venue/*` or `https://papers.cool/arxiv/*` page.

#### Usage

Rate papers on the page and the script will call the server to reorder papers based on your preferences.