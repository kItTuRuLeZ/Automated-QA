# Course QA Automation

Local, evidence-backed QA scanning for published eLearning courses (Rise, Storyline, custom HTML). Core scanning needs no AI service.

Status: Phase 0 (architecture and contracts) complete. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

- [PROJECT.md](PROJECT.md): scope and non-claims
- [ARCHITECTURE.md](ARCHITECTURE.md): components, lifecycle, decisions
- [docs/QA_RULE_CATALOG.md](docs/QA_RULE_CATALOG.md): rules and capability matrix
- [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md): network policy and isolation
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md): fixtures and tests

## Requirements

Node.js 24 LTS (see `.nvmrc`).

```bash
npm install
npm run typecheck
```
