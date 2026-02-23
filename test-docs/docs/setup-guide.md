---
title: Setup Guide
type: fact
tags: [setup, installation, getting-started]
---

# Setup Guide

## Installation

To install the memory system:

```bash
npm install -g zmem
```

## Configuration

Create a `config.json` file:

```json
{
  "workspaces": [
    {
      "name": "my-project",
      "root": "/path/to/project",
      "patterns": ["**/*.md"]
    }
  ]
}
```

## First Steps

1. Initialize the database
2. Run your first ingestion
3. Query your documents

## Troubleshooting

If you encounter issues, check the logs.
