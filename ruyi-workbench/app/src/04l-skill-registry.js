// Both turn assembly and tool dispatch consume the same skill registry.
const { createSkillRegistry, effectiveSkillSelection } = require('./backend/skill-registry.cjs');
const SkillRegistry = createSkillRegistry({ SKILL_ID_RE, agentCliHomes, externalRoot, paths, readIfExists, safeJsonParse });
const { resolveEnabledSkillEntries } = SkillRegistry;
