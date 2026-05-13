const PROPERTY_KEYS = {
  SHEET_NAME: 'SHEET_NAME',
  DISCORD_WEBHOOK_URL: 'DISCORD_WEBHOOK_URL',
  EMAIL_TO: 'EMAIL_TO',
  ENABLE_DISCORD: 'ENABLE_DISCORD',
  ENABLE_EMAIL: 'ENABLE_EMAIL',
  NOTIFIER_INITIALIZED: 'NOTIFIER_INITIALIZED',
  LAST_NOTIFIED_ROW: 'LAST_NOTIFIED_ROW',
  PENDING_NOTIFICATION_STATE: 'PENDING_NOTIFICATION_STATE',
};

const DEFAULTS = {
  SHEET_NAME: 'Responses',
  ENABLE_DISCORD: true,
  ENABLE_EMAIL: true,
  DISCORD_USERNAME: 'Spreadsheet Notifier',
  NOTIFICATION_ID_HEADER: '通知ID',
  DISCORD_STATUS_HEADER: 'Discord通知済み',
  EMAIL_STATUS_HEADER: 'Gmail通知済み',
  SNAPSHOT_HEADER: '通知スナップショット',
};

const HEADER_ALIASES = {
  datetime: ['日時', 'タイムスタンプ', 'Timestamp', 'Date'],
  name: ['名前', 'Name'],
  content: ['内容', '本文', 'Message', 'Content'],
  notificationId: ['通知ID', 'Notification ID'],
  discordStatus: ['Discord通知済み', 'Discord Status'],
  emailStatus: ['Gmail通知済み', 'Email Status'],
  snapshot: ['通知スナップショット', 'Notification Snapshot'],
};

const STATUS_PREFIXES = {
  SENT: 'SENT',
  SKIPPED: 'SKIPPED',
  INITIAL_SYNC: 'INITIAL_SYNC',
};

/**
 * Time-driven trigger entrypoint.
 * Scans rows by notification ID so row order changes do not cause duplicates.
 */
function checkNewRows() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another checkNewRows execution is already running.');
    return;
  }

  try {
    checkNewRowsWithLock_();
  } finally {
    lock.releaseLock();
  }
}

function checkNewRowsWithLock_() {
  const props = PropertiesService.getScriptProperties();
  const config = getConfig_(props);
  const sheet = getTargetSheet_(config.sheetName);
  const sheetContext = getSheetContext_(sheet);
  const destinations = getDestinationDefinitions_(config);
  const rows = getDataRows_(sheet, sheetContext.lastColumn);

  if (!isNotifierInitialized_(props)) {
    initializeExistingRows_(sheet, rows, sheetContext.columnMap, destinations);
    markNotifierInitialized_(props);
    clearLegacyRowState_(props);
    Logger.log('Initial sync completed. Existing complete rows were marked as already processed.');
    return;
  }

  if (!hasDeliverableDestination_(destinations)) {
    Logger.log('No notification destination is configured.');
    return;
  }

  processRows_(sheet, rows, sheetContext.columnMap, destinations);
  clearLegacyRowState_(props);
}

/**
 * Creates a 5-minute time-driven trigger for checkNewRows.
 * Run this once from the Apps Script editor after setting ScriptProperties.
 */
function installTimeDrivenTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i += 1) {
    if (triggers[i].getHandlerFunction() === 'checkNewRows') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('checkNewRows')
    .timeBased()
    .everyMinutes(5)
    .create();
}

/**
 * Clears saved setup state. Existing sheet status columns are not cleared.
 */
function resetNotificationState() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROPERTY_KEYS.NOTIFIER_INITIALIZED);
  clearLegacyRowState_(props);
}

/**
 * Backward-compatible alias for older README versions.
 */
function resetLastNotifiedRow() {
  resetNotificationState();
}

function getConfig_(props) {
  return {
    sheetName: props.getProperty(PROPERTY_KEYS.SHEET_NAME) || DEFAULTS.SHEET_NAME,
    discordWebhookUrl: props.getProperty(PROPERTY_KEYS.DISCORD_WEBHOOK_URL) || '',
    emailTo: props.getProperty(PROPERTY_KEYS.EMAIL_TO) || '',
    enableDiscord: parseBoolean_(
      props.getProperty(PROPERTY_KEYS.ENABLE_DISCORD),
      DEFAULTS.ENABLE_DISCORD
    ),
    enableEmail: parseBoolean_(
      props.getProperty(PROPERTY_KEYS.ENABLE_EMAIL),
      DEFAULTS.ENABLE_EMAIL
    ),
  };
}

function getTargetSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('No active spreadsheet was found. Use this script as a bound spreadsheet script.');
  }

  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Sheet not found: ' + sheetName);
  }

  return sheet;
}

function getSheetContext_(sheet) {
  const headerColumnCount = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, headerColumnCount).getValues()[0];
  const columnMap = {
    datetime: findRequiredHeaderIndex_(headers, HEADER_ALIASES.datetime),
    name: findRequiredHeaderIndex_(headers, HEADER_ALIASES.name),
    content: findRequiredHeaderIndex_(headers, HEADER_ALIASES.content),
  };

  columnMap.notificationId = ensureHeader_(sheet, headers, HEADER_ALIASES.notificationId, DEFAULTS.NOTIFICATION_ID_HEADER);
  columnMap.discordStatus = ensureHeader_(sheet, headers, HEADER_ALIASES.discordStatus, DEFAULTS.DISCORD_STATUS_HEADER);
  columnMap.emailStatus = ensureHeader_(sheet, headers, HEADER_ALIASES.emailStatus, DEFAULTS.EMAIL_STATUS_HEADER);
  columnMap.snapshot = ensureHeader_(sheet, headers, HEADER_ALIASES.snapshot, DEFAULTS.SNAPSHOT_HEADER);

  return {
    columnMap: columnMap,
    lastColumn: headers.length,
  };
}

function ensureHeader_(sheet, headers, aliases, defaultHeader) {
  const existingIndex = findOptionalHeaderIndex_(headers, aliases);
  if (existingIndex !== -1) {
    return existingIndex;
  }

  const columnNumber = headers.length + 1;
  sheet.getRange(1, columnNumber).setValue(defaultHeader);
  headers.push(defaultHeader);
  return headers.length - 1;
}

function findRequiredHeaderIndex_(headers, aliases) {
  const index = findOptionalHeaderIndex_(headers, aliases);
  if (index === -1) {
    throw new Error('Required header was not found: ' + aliases[0]);
  }

  return index;
}

function findOptionalHeaderIndex_(headers, aliases) {
  const normalizedHeaders = headers.map(function (header) {
    return normalizeText_(header);
  });

  for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
    const normalizedAlias = normalizeText_(aliases[aliasIndex]);
    const matchIndex = normalizedHeaders.indexOf(normalizedAlias);
    if (matchIndex !== -1) {
      return matchIndex;
    }
  }

  return -1;
}

function getDataRows_(sheet, lastColumn) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  return sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
}

function initializeExistingRows_(sheet, rows, columnMap, destinations) {
  const seenIds = {};

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;

    if (!rowHasPublicInput_(row, columnMap)) {
      continue;
    }

    ensureUniqueNotificationId_(sheet, row, rowNumber, columnMap, seenIds);
    const entry = buildEntry_(row, columnMap, rowNumber, sheet.getName());

    if (!isNotifiableEntry_(entry)) {
      Logger.log('Initial sync left row %s pending because name or content is empty.', rowNumber);
      continue;
    }

    markInitialSync_(sheet, row, rowNumber, columnMap, destinations);
  }
}

function processRows_(sheet, rows, columnMap, destinations) {
  const seenIds = {};

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;

    if (!rowHasPublicInput_(row, columnMap)) {
      continue;
    }

    ensureUniqueNotificationId_(sheet, row, rowNumber, columnMap, seenIds);
    const currentEntry = buildEntry_(row, columnMap, rowNumber, sheet.getName());

    if (!isNotifiableEntry_(currentEntry)) {
      Logger.log('Skipped row %s because name or content is empty. It will be checked again later.', rowNumber);
      continue;
    }

    if (areAllDestinationStatusesComplete_(row, columnMap, destinations)) {
      continue;
    }

    const notificationEntry = getOrCreateSnapshotEntry_(sheet, row, rowNumber, columnMap, currentEntry);
    const result = notifyEntry_(sheet, row, rowNumber, columnMap, notificationEntry, destinations);

    if (!result.complete) {
      Logger.log('Row %s still has pending destinations and will be retried later.', rowNumber);
      break;
    }
  }
}

function ensureUniqueNotificationId_(sheet, row, rowNumber, columnMap, seenIds) {
  const idColumn = columnMap.notificationId;
  let notificationId = cellToText_(row[idColumn]);

  if (notificationId && !seenIds[notificationId]) {
    seenIds[notificationId] = true;
    return notificationId;
  }

  notificationId = createUniqueId_(seenIds);
  writeCellValue_(sheet, row, rowNumber, idColumn, notificationId);
  clearRowNotificationState_(sheet, row, rowNumber, columnMap);
  return notificationId;
}

function createUniqueId_(seenIds) {
  let notificationId = Utilities.getUuid();
  while (seenIds[notificationId]) {
    notificationId = Utilities.getUuid();
  }

  seenIds[notificationId] = true;
  return notificationId;
}

function clearRowNotificationState_(sheet, row, rowNumber, columnMap) {
  writeCellValue_(sheet, row, rowNumber, columnMap.discordStatus, '');
  writeCellValue_(sheet, row, rowNumber, columnMap.emailStatus, '');
  writeCellValue_(sheet, row, rowNumber, columnMap.snapshot, '');
}

function markInitialSync_(sheet, row, rowNumber, columnMap, destinations) {
  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    writeDestinationStatus_(sheet, row, rowNumber, columnMap, destination, STATUS_PREFIXES.INITIAL_SYNC);
  }
}

function buildEntry_(row, columnMap, rowNumber, sheetName) {
  const datetimeText = formatDateValue_(row[columnMap.datetime]) || formatDateValue_(new Date());

  return {
    id: cellToText_(row[columnMap.notificationId]),
    rowNumber: rowNumber,
    sheetName: sheetName,
    datetime: datetimeText,
    name: cellToText_(row[columnMap.name]),
    content: cellToText_(row[columnMap.content]),
  };
}

function getOrCreateSnapshotEntry_(sheet, row, rowNumber, columnMap, currentEntry) {
  const snapshotText = cellToText_(row[columnMap.snapshot]);
  const snapshotEntry = parseSnapshotEntry_(snapshotText, currentEntry);

  if (snapshotEntry) {
    snapshotEntry.rowNumber = rowNumber;
    snapshotEntry.sheetName = currentEntry.sheetName;
    return snapshotEntry;
  }

  const snapshot = {
    id: currentEntry.id,
    datetime: currentEntry.datetime,
    name: currentEntry.name,
    content: currentEntry.content,
  };
  writeCellValue_(sheet, row, rowNumber, columnMap.snapshot, JSON.stringify(snapshot));
  return currentEntry;
}

function parseSnapshotEntry_(snapshotText, currentEntry) {
  if (!snapshotText) {
    return null;
  }

  try {
    const snapshot = JSON.parse(snapshotText);
    if (snapshot.id !== currentEntry.id) {
      return null;
    }

    return {
      id: snapshot.id,
      rowNumber: currentEntry.rowNumber,
      sheetName: currentEntry.sheetName,
      datetime: cellToText_(snapshot.datetime) || currentEntry.datetime,
      name: cellToText_(snapshot.name) || currentEntry.name,
      content: cellToText_(snapshot.content) || currentEntry.content,
    };
  } catch (error) {
    Logger.log('Failed to parse notification snapshot for row %s: %s', currentEntry.rowNumber, error.message);
    return null;
  }
}

function isNotifiableEntry_(entry) {
  return entry.name !== '' && entry.content !== '';
}

function rowHasPublicInput_(row, columnMap) {
  return (
    cellToText_(row[columnMap.datetime]) !== '' ||
    cellToText_(row[columnMap.name]) !== '' ||
    cellToText_(row[columnMap.content]) !== ''
  );
}

function notifyEntry_(sheet, row, rowNumber, columnMap, entry, destinations) {
  let hasFailure = false;

  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    const status = cellToText_(row[columnMap[destination.statusKey]]);

    if (status) {
      continue;
    }

    if (!destination.enabled || !destination.configured) {
      writeDestinationStatus_(sheet, row, rowNumber, columnMap, destination, STATUS_PREFIXES.SKIPPED);
      continue;
    }

    try {
      destination.send(entry);
      writeDestinationStatus_(sheet, row, rowNumber, columnMap, destination, STATUS_PREFIXES.SENT);
    } catch (error) {
      hasFailure = true;
      Logger.log('%s notification failed for row %s: %s', destination.label, rowNumber, error.message);
    }
  }

  return {
    complete: !hasFailure && areAllDestinationStatusesComplete_(row, columnMap, destinations),
  };
}

function getDestinationDefinitions_(config) {
  return [
    {
      key: 'discord',
      label: 'Discord',
      statusKey: 'discordStatus',
      enabled: config.enableDiscord,
      configured: config.discordWebhookUrl !== '',
      send: function (entry) {
        sendDiscordNotification_(entry, config.discordWebhookUrl);
      },
    },
    {
      key: 'email',
      label: 'Email',
      statusKey: 'emailStatus',
      enabled: config.enableEmail,
      configured: config.emailTo !== '',
      send: function (entry) {
        sendEmailNotification_(entry, config.emailTo);
      },
    },
  ];
}

function hasDeliverableDestination_(destinations) {
  for (let index = 0; index < destinations.length; index += 1) {
    if (destinations[index].enabled && destinations[index].configured) {
      return true;
    }
  }

  return false;
}

function areAllDestinationStatusesComplete_(row, columnMap, destinations) {
  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    if (!cellToText_(row[columnMap[destination.statusKey]])) {
      return false;
    }
  }

  return true;
}

function writeDestinationStatus_(sheet, row, rowNumber, columnMap, destination, prefix) {
  const status = prefix + ' ' + formatDateValue_(new Date());
  writeCellValue_(sheet, row, rowNumber, columnMap[destination.statusKey], status);
}

function writeCellValue_(sheet, row, rowNumber, zeroBasedColumnIndex, value) {
  sheet.getRange(rowNumber, zeroBasedColumnIndex + 1).setValue(value);
  row[zeroBasedColumnIndex] = value;
}

function clearLegacyRowState_(props) {
  props.deleteProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW);
  props.deleteProperty(PROPERTY_KEYS.PENDING_NOTIFICATION_STATE);
}

function isNotifierInitialized_(props) {
  return props.getProperty(PROPERTY_KEYS.NOTIFIER_INITIALIZED) === 'true';
}

function markNotifierInitialized_(props) {
  props.setProperty(PROPERTY_KEYS.NOTIFIER_INITIALIZED, 'true');
}

function sendDiscordNotification_(entry, webhookUrl) {
  const payload = {
    username: DEFAULTS.DISCORD_USERNAME,
    embeds: [
      {
        title: 'スプレッドシートに新しい行が追加されました',
        color: 3447003,
        fields: [
          {
            name: '名前',
            value: entry.name,
            inline: true,
          },
          {
            name: '日時',
            value: entry.datetime,
            inline: true,
          },
          {
            name: '内容',
            value: truncate_(entry.content, 1000),
            inline: false,
          },
        ],
        footer: {
          text: entry.sheetName + ' / row ' + entry.rowNumber + ' / id ' + entry.id,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('Discord webhook returned HTTP ' + statusCode + ': ' + response.getContentText());
  }
}

function sendEmailNotification_(entry, emailTo) {
  const subject = 'スプレッドシートに新しい行が追加されました';
  const body = buildEmailBody_(entry);

  MailApp.sendEmail({
    to: emailTo,
    subject: subject,
    body: body,
    name: DEFAULTS.DISCORD_USERNAME,
  });
}

function buildEmailBody_(entry) {
  return [
    'スプレッドシートに新しい行が追加されました。',
    '',
    '名前: ' + entry.name,
    '内容: ' + entry.content,
    '日時: ' + entry.datetime,
    'シート: ' + entry.sheetName,
    '行番号: ' + entry.rowNumber,
    '通知ID: ' + entry.id,
  ].join('\n');
}

function parseBoolean_(value, defaultValue) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function formatDateValue_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
  }

  return cellToText_(value);
}

function cellToText_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizeText_(value) {
  return cellToText_(value).toLowerCase();
}

function truncate_(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 1) + '…';
}
