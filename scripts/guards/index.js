'use strict';

// Every guard the hook runs, in order. Each one exports { id, tools, check }, where check
// returns null to allow the call or a sentence explaining why it was stopped.
module.exports = [require('./secret-files'), require('./force-push'), require('./destructive-commands')];
