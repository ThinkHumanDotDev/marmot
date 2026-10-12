/**
 * `req.context` flag set while an import writes (#120): imported incidents and maintenance windows
 * are history that the source already announced, so their updates are not announced again to
 * subscribers and webhooks.
 */
export const IMPORT_SILENT_CONTEXT = 'importSilent'
