const PROPERTY_KEYS = {
  SHEET_NAME: 'SHEET_NAME',
  DISCORD_WEBHOOK_URL: 'DISCORD_WEBHOOK_URL',
  EMAIL_TO: 'EMAIL_TO',
  ENABLE_DISCORD: 'ENABLE_DISCORD',
  ENABLE_EMAIL: 'ENABLE_EMAIL',
  LAST_NOTIFIED_ROW: 'LAST_NOTIFIED_ROW',
};

const DEFAULTS = {
  SHEET_NAME: 'Responses',
  ENABLE_DISCORD: true,
  ENABLE_EMAIL: true,
  DISCORD_USERNAME: 'Spreadsheet Notifier',
};

const HEADER_ALIASES = {
  datetime: ['日時', 'タイムスタンプ', 'Timestamp', 'Date'],
  name: ['名前', 'Name'],
  content: ['内容', '本文', 'Message', 'Content'],
};

/**
 * Time-driven trigger entrypoint.
 * Checks for rows added after LAST_NOTIFIED_ROW and sends notifications.
 */
function checkNewRows() {
  const props = PropertiesService.getScriptProperties();
  const config = getConfig_(props);
  const sheet = getTargetSheet_(config.sheetName);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    props.setProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW, String(lastRow));
    Logger.log('No data rows found. LAST_NOTIFIED_ROW was set to %s.', lastRow);
    return;
  }

  const storedLastRow = props.getProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW);
  if (!storedLastRow) {
    props.setProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW, String(lastRow));
    Logger.log('First run detected. Existing rows were skipped up to row %s.', lastRow);
    return;
  }

  let lastNotifiedRow = Number(storedLastRow);
  if (!Number.isFinite(lastNotifiedRow) || lastNotifiedRow < 1) {
    lastNotifiedRow = 1;
  }

  if (lastNotifiedRow > lastRow) {
    props.setProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW, String(lastRow));
    Logger.log('Sheet has fewer rows than saved state. LAST_NOTIFIED_ROW was reset to %s.', lastRow);
    return;
  }

  if (lastRow <= lastNotifiedRow) {
    Logger.log('No new rows. lastRow=%s, LAST_NOTIFIED_ROW=%s', lastRow, lastNotifiedRow);
    return;
  }

  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const columnMap = buildColumnMap_(headers);
  const rowCount = lastRow - lastNotifiedRow;
  const rows = sheet.getRange(lastNotifiedRow + 1, 1, rowCount, lastColumn).getValues();
  let highestDeliveredRow = lastNotifiedRow;

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = lastNotifiedRow + index + 1;
    const entry = buildEntry_(rows[index], columnMap, rowNumber, sheet.getName());

    if (!isNotifiableEntry_(entry)) {
      Logger.log('Skipped row %s because name or content is empty.', rowNumber);
      continue;
    }

    try {
      const delivered = notifyEntry_(entry, config);
      if (!delivered) {
        Logger.log('Row %s was not delivered because no destination was available.', rowNumber);
        break;
      }
      highestDeliveredRow = rowNumber;
    } catch (error) {
      Logger.log('Failed to notify row %s: %s', rowNumber, error.message);
      break;
    }
  }

  if (highestDeliveredRow > lastNotifiedRow) {
    props.setProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW, String(highestDeliveredRow));
    Logger.log('LAST_NOTIFIED_ROW was updated to %s.', highestDeliveredRow);
  }
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
 * Clears saved delivery state.
 * The next checkNewRows run will initialize from the current last row.
 */
function resetLastNotifiedRow() {
  PropertiesService.getScriptProperties().deleteProperty(PROPERTY_KEYS.LAST_NOTIFIED_ROW);
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

function buildColumnMap_(headers) {
  return {
    datetime: findHeaderIndex_(headers, HEADER_ALIASES.datetime),
    name: findHeaderIndex_(headers, HEADER_ALIASES.name),
    content: findHeaderIndex_(headers, HEADER_ALIASES.content),
  };
}

function findHeaderIndex_(headers, aliases) {
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

  throw new Error('Required header was not found: ' + aliases[0]);
}

function buildEntry_(row, columnMap, rowNumber, sheetName) {
  const datetimeText = formatDateValue_(row[columnMap.datetime]) || formatDateValue_(new Date());

  return {
    rowNumber: rowNumber,
    sheetName: sheetName,
    datetime: datetimeText,
    name: cellToText_(row[columnMap.name]),
    content: cellToText_(row[columnMap.content]),
  };
}

function isNotifiableEntry_(entry) {
  return entry.name !== '' && entry.content !== '';
}

function notifyEntry_(entry, config) {
  let sentCount = 0;
  const failures = [];

  if (config.enableDiscord) {
    if (config.discordWebhookUrl) {
      try {
        sendDiscordNotification_(entry, config.discordWebhookUrl);
        sentCount += 1;
      } catch (error) {
        failures.push('Discord: ' + error.message);
      }
    } else {
      Logger.log('Discord notification is enabled but DISCORD_WEBHOOK_URL is empty.');
    }
  }

  if (config.enableEmail) {
    if (config.emailTo) {
      try {
        sendEmailNotification_(entry, config.emailTo);
        sentCount += 1;
      } catch (error) {
        failures.push('Email: ' + error.message);
      }
    } else {
      Logger.log('Email notification is enabled but EMAIL_TO is empty.');
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join(' / '));
  }

  return sentCount > 0;
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
          text: entry.sheetName + ' / row ' + entry.rowNumber,
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
