# No prompt without its evaluation

The companion is an agent system with many prompts (grouping, story, ranking, finding claims, judging claims, criteria mapping, asks, draft comments), and a prompt behaves differently on each model. So every prompt lands together with its own small test set and score, prompts are versioned like code, any prompt change automatically runs a cheap evaluation subset against the last baseline, and every run is traced locally and stamped with prompt version, agent and model. Plain checks come before model judges, and any judge is itself checked against hand labels. The evaluation starts lean, as a script with a few hand-made cases, and grows one prompt at a time.

## Considered Options

- End-to-end evaluation only: rejected, it shows that something got worse but not which prompt or model caused it.
