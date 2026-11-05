# CIViC MCP Server

MCP-supported Chatbot for CIViC users: https://civicdb.org/mcp-chat

If you use the CIViC MCP Server in published work, please cite: [CIViC MCP: integrating large language models with the Clinical Interpretations of Variants in Cancer](https://academic.oup.com/bioinformaticsadvances/article/6/1/vbag209/8746878)

This is a Cloudflare Workers-based Model Context Protocol (MCP) server that provides tools for querying the CIViC (Clinical Interpretation of Variants in Cancer) API. 

The CIViC database is a crowd-sourced repository of clinical interpretations of cancer variants. This MCP server enables structured queries and data analysis of cancer genomics information through natural language interactions with AI assistants.

Python 3.11.7
```bash
pip install -r requirements.txt
```

## Directly Querying the MCP Server

The MCP Server can be called directly from the command line with the optional arguments disease and therapy to get CIViC evidence items:

```bash
python MCP_query_evidence.py --mp "EGFR" --disease "Lung Non-small Cell Carcinoma" --therapy "Erlotinib"
```

## Locally Hosting The CIViC MCP Server

We provide an example of doing this with GPT4o-mini. A personal API key is required, update the variable OPENAI_API_KEY in local_hosting/message_MCP_CIViC.py

```bash
python local_hosting/message_MCP_CIViC.py --msg "What is the clinical significance of EGFR variants in CIViC?" 
```

## Adding as a Claude Connector

<img width="3217" height="1094" alt="Claude connector setup" src="https://github.com/user-attachments/assets/b939db57-4a59-4cdf-a38e-620d9516cee4" />

Connector V2 URL: https://civic-mcp-server-v2.larscivic.workers.dev/mcp

Select sign-in not required

## Usage

The server provides two main tools:

1. **`get_variant_evidence`**: Return up to 50 evidence items for a CIViC molecular profile
2. **`get_variant_assertions`**: Return CIViC assertions for a molecular profile


## Evaluation Scripts

All evaluation files are located in eval_QA_experiment. The file agent_mode_run_results.csv contains the agent mode prompts and responses; the associated chat URLs were created but may no longer be available. QA_triplet_dataset.csv contains the 100 unique (Molecular Profile, Disease, Therapy) triplets along with their expected answers.


## License

MIT License with Academic Citation Requirement - see [LICENSE.md](LICENSE.md)
