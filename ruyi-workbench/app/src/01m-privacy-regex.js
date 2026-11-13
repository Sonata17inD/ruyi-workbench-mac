// Explicit privacy service composition; implementations have no host dependency.
const PrivacyRegex = require('./backend/privacy-regex.cjs').createPrivacyRegex({ core: PrivacyCore });
