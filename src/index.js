const ORIGIN_URL = 'https://kamaz-scrypt.taile47694.ts.net';

async function proxyToServer(request) {
  const incoming = new URL(request.url);

  const target = new URL(
    incoming.pathname + incoming.search,
    ORIGIN_URL
  );

  const headers = new Headers(request.headers);

  headers.delete('host');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');

 const options = {
  method: request.method,
  headers,
  redirect: 'manual'
};

  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD'
  ) {
    options.body = request.body;
  }

  const response = await fetch(
    target.toString(),
    options
  );

  const responseHeaders =
    new Headers(response.headers);

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    }
  );
}
const CALL_RESULT_FIELD_TITLE = 'Результат звонка';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}
 
function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isEmptyEnumLabel(value) {
  const v = normalizeText(value);
  return ['', 'не выбрано', 'не выбран', 'не выбрана', 'не выбрано.'].includes(v);
}

async function restCall(domain, accessToken, method, params = {}) {
  const cleanDomain = String(domain || '').replace(/^https?:\/\//i, '').trim();

  if (!cleanDomain || !accessToken) {
    return {
      error: 'NO_AUTH',
      error_description: 'Нет данных авторизации Bitrix24',
    };
  }

  const response = await fetch(`https://${cleanDomain}/rest/${method}.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      ...params,
      auth: accessToken,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    return {
      error: 'BAD_RESPONSE',
      error_description: `HTTP ${response.status}`,
    };
  }

  return data;
}

async function findCallResultField(domain, accessToken) {
  let start = 0;

  for (let page = 0; page < 20; page++) {
    const response = await restCall(
      domain,
      accessToken,
      'crm.lead.userfield.list',
      {
        order: {
          SORT: 'ASC',
          ID: 'ASC',
        },
        filter: {
          USER_TYPE_ID: 'enumeration',
          LANG: 'ru',
        },
        start,
      }
    );

    if (response.error) {
      return null;
    }

    const items = Array.isArray(response.result)
      ? response.result
      : [];

    for (const field of items) {
      const labels = [
        field.EDIT_FORM_LABEL,
        field.LIST_COLUMN_LABEL,
        field.LIST_FILTER_LABEL,
        field.LABEL,
        field.TITLE,
      ];

      let found = false;

      for (let label of labels) {
        if (label && typeof label === 'object') {
          label = label.ru || '';
        }

        if (normalizeText(label) === normalizeText(CALL_RESULT_FIELD_TITLE)) {
          found = true;
          break;
        }
      }

      if (!found) continue;

      if (Array.isArray(field.LIST)) {
        return field;
      }

      const fieldId = Number(field.ID || 0);

      if (fieldId > 0) {
        const getResponse = await restCall(
          domain,
          accessToken,
          'crm.lead.userfield.get',
          { id: fieldId }
        );

        if (!getResponse.error && getResponse.result) {
          return getResponse.result;
        }
      }

      return field;
    }

    if (
      response.next === undefined
      ||
      response.next === null
      ||
      response.next === false
    ) {
      break;
    }

    start = Number(response.next || 0);
  }

  return null;
}

function invalidEnumIds(field) {
  const list = Array.isArray(field?.LIST)
    ? field.LIST
    : [];

  const invalid = [];

  for (const item of list) {
    const id = String(item?.ID ?? item?.id ?? '');
    const value = String(item?.VALUE ?? item?.value ?? '');

    if (id && isEmptyEnumLabel(value)) {
      invalid.push(id);
    }
  }

  return invalid;
}

function callResultFilled(value, invalidIds) {
  if (Array.isArray(value)) {
    const values = value
      .map(v => String(v ?? '').trim())
      .filter(Boolean);

    return values.some(v => !invalidIds.includes(v));
  }

  const v = String(value ?? '').trim();

  return v !== '' && !invalidIds.includes(v);
}

async function activityGuard(request) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json({
      ok: false,
      error: 'bad_form_data',
    }, 400);
  }

  const event = String(form.get('event') || '').toLowerCase();

  if (event !== 'oncrmactivityupdate') {
    return json({
      ok: true,
      ignored: 'wrong_event',
    });
  }

  const activityId = Number(
    form.get('data[FIELDS][ID]')
    ||
    form.get('data[fields][ID]')
    ||
    0
  );

  const domain = String(form.get('auth[domain]') || '');
  const accessToken = String(form.get('auth[access_token]') || '');

  if (!activityId || !domain || !accessToken) {
    return json({
      ok: false,
      error: 'missing_event_data',
    });
  }

  const activityResponse = await restCall(
    domain,
    accessToken,
    'crm.activity.get',
    { id: activityId }
  );

  if (activityResponse.error) {
    return json({
      ok: false,
      error: 'activity_get_failed',
      detail: activityResponse.error,
    });
  }

  const activity = activityResponse.result || {};

  const typeId = Number(activity.TYPE_ID || 0);
  const ownerTypeId = Number(activity.OWNER_TYPE_ID || 0);
  const leadId = Number(activity.OWNER_ID || 0);
  const completed = String(activity.COMPLETED || 'N').toUpperCase();

  if (
    typeId !== 2
    ||
    ownerTypeId !== 1
    ||
    !leadId
    ||
    completed !== 'Y'
  ) {
    return json({
      ok: true,
      ignored: 'not_completed_lead_call',
    });
  }

  const leadResponse = await restCall(
    domain,
    accessToken,
    'crm.lead.get',
    { id: leadId }
  );

  if (leadResponse.error) {
    return json({
      ok: false,
      error: 'lead_get_failed',
    });
  }

  const lead = leadResponse.result || {};
  const field = await findCallResultField(domain, accessToken);

  if (!field) {
    return json({
      ok: false,
      error: 'call_result_field_not_found',
    });
  }

  const fieldCode = String(field.FIELD_NAME || '').trim();

  if (!fieldCode) {
    return json({
      ok: false,
      error: 'call_result_field_code_empty',
    });
  }

  const invalidIds = invalidEnumIds(field);
  const leadValue = lead[fieldCode];

  if (callResultFilled(leadValue, invalidIds)) {
    return json({
      ok: true,
      allowed: true,
      leadId,
      activityId,
    });
  }

  const reopen = await restCall(
    domain,
    accessToken,
    'crm.activity.update',
    {
      id: activityId,
      fields: {
        OWNER_ID: leadId,
        OWNER_TYPE_ID: ownerTypeId,
        TYPE_ID: typeId,
        COMPLETED: 'N',
      },
    }
  );

  if (reopen.error) {
    return json({
      ok: false,
      error: 'activity_reopen_failed',
      detail: reopen.error,
    });
  }

  await restCall(
    domain,
    accessToken,
    'crm.timeline.comment.add',
    {
      fields: {
        ENTITY_ID: leadId,
        ENTITY_TYPE: 'lead',
        COMMENT:
          '⚠️ Звонок не завершён. Перед завершением заполните обязательное поле «Результат звонка» в карточке лида.',
      },
    }
  );

  return json({
    ok: true,
    allowed: false,
    reopened: true,
    leadId,
    activityId,
  });
}


async function getLeadStages(domain, accessToken) {
  const response = await restCall(
    domain,
    accessToken,
    'crm.status.list',
    {
      filter: {
        ENTITY_ID: 'STATUS',
      },
      order: {
        SORT: 'ASC',
      },
    }
  );

  if (response.error) {
    return [];
  }

  return Array.isArray(response.result)
    ? response.result
    : [];
}

async function findLeadStatusIdByName(domain, accessToken, stageName) {
  const stages = await getLeadStages(domain, accessToken);
  const target = stages.find(
    stage => normalizeText(stage?.NAME) === normalizeText(stageName)
  );

  return String(target?.STATUS_ID || '');
}

async function getPrimaryLeadContact(domain, accessToken, leadId) {
  const response = await restCall(
    domain,
    accessToken,
    'crm.lead.contact.items.get',
    {
      id: leadId,
    }
  );

  if (response.error) {
    return {
      ok: false,
      error: response.error,
      contactId: 0,
    };
  }

  const items = Array.isArray(response.result)
    ? response.result
    : [];

  if (!items.length) {
    return {
      ok: true,
      contactId: 0,
    };
  }

  const primary =
    items.find(
      item => String(item?.IS_PRIMARY || '').toUpperCase() === 'Y'
    )
    || items[0];

  return {
    ok: true,
    contactId: Number(primary?.CONTACT_ID || 0),
  };
}

function contactHasPhone(contact) {
  const phones = Array.isArray(contact?.PHONE)
    ? contact.PHONE
    : [];

  /*
   * Bitrix иногда отдаёт в PHONE только маску/код страны,
   * например "+7".
   *
   * Такое значение не считаем полноценным телефоном.
   * Требуем минимум 10 цифр.
   */

  return phones.some(function (item) {
    const raw = String(
      item?.VALUE || ''
    ).trim();

    const digits = raw.replace(
      /\D/g,
      ''
    );

    return digits.length >= 10;
  });
}

async function addLeadTimelineComment(
  domain,
  accessToken,
  leadId,
  comment
) {
  return restCall(
    domain,
    accessToken,
    'crm.timeline.comment.add',
    {
      fields: {
        ENTITY_ID: leadId,
        ENTITY_TYPE: 'lead',
        COMMENT: comment,
      },
    }
  );
}
const NO_PHONE_REASON_FIELD_TITLE =
  'Почему не взяли контакт клиента?';


async function findLeadUserFieldByTitle(
  domain,
  accessToken,
  title
) {

  let start = 0;


  for (
    let page = 0;
    page < 20;
    page++
  ) {

    const response =
      await restCall(
        domain,
        accessToken,
        'crm.lead.userfield.list',
        {
          order: {
            ID: 'ASC'
          },

          start:
            start
        }
      );


    if (
      response.error
    ) {

      return null;
    }


    const fields =
      Array.isArray(
        response.result
      )
        ?
        response.result
        :
        [];


    for (
      const field
      of fields
    ) {

      const labels = [

        field.EDIT_FORM_LABEL,
        field.LIST_COLUMN_LABEL,
        field.LIST_FILTER_LABEL,
        field.LABEL,
        field.TITLE

      ];


      for (
        let label
        of labels
      ) {

        if (
          label
          &&
          typeof label
          === 'object'
        ) {

          label =
            label.ru
            ||
            '';
        }


        if (
          normalizeText(
            label
          )
          ===
          normalizeText(
            title
          )
        ) {

          return field;
        }
      }
    }


    if (
      response.next === undefined
      ||
      response.next === null
      ||
      response.next === false
    ) {

      break;
    }


    start =
      Number(
        response.next || 0
      );
  }


  return null;
}
async function leadPhoneGuard(request) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json({
      ok: false,
      error: 'bad_form_data',
    }, 400);
  }

  const event = String(
    form.get('event') || ''
  ).toLowerCase();

  if (event !== 'oncrmleadupdate') {
    return json({
      ok: true,
      ignored: 'wrong_event',
    });
  }

  const leadId = Number(
    form.get('data[FIELDS][ID]')
    ||
    form.get('data[fields][ID]')
    ||
    0
  );

  const domain = String(
    form.get('auth[domain]') || ''
  );

  const accessToken = String(
    form.get('auth[access_token]') || ''
  );

  if (!leadId || !domain || !accessToken) {
    return json({
      ok: false,
      error: 'missing_event_data',
    });
  }

  const leadResponse = await restCall(
    domain,
    accessToken,
    'crm.lead.get',
    {
      id: leadId,
    }
  );

  if (leadResponse.error) {
    return json({
      ok: false,
      error: 'lead_get_failed',
      detail: leadResponse.error,
    });
  }

  const lead = leadResponse.result || {};

  const currentStatusId = String(
    lead.STATUS_ID || ''
  );

  const newStatusId = await findLeadStatusIdByName(
    domain,
    accessToken,
    'Новый'
  );

  if (!newStatusId) {
    return json({
      ok: false,
      error: 'new_stage_not_found',
    });
  }

  /*
   * На стадии "Новый" телефон можно заполнить.
   * Проверяем только попытку работать с лидом дальше.
   */
  if (currentStatusId === newStatusId) {
    return json({
      ok: true,
      allowed: true,
      stage: 'new',
    });
  }

  const contactLink = await getPrimaryLeadContact(
    domain,
    accessToken,
    leadId
  );

  let contactId = Number(
    contactLink.contactId || 0
  );

  /*
   * Fallback для старых карточек/порталов.
   */
  if (!contactId) {
    contactId = Number(
      lead.CONTACT_ID || 0
    );
  }

  let reason = '';
  let hasPhone = false;

  if (!contactId) {
    reason =
      'В поле «Клиент» не выбран контакт. Добавьте контакт и заполните его телефон.';
  } else {
    const contactResponse = await restCall(
      domain,
      accessToken,
      'crm.contact.get',
      {
        id: contactId,
      }
    );

    if (contactResponse.error) {
      reason =
        'Не удалось проверить телефон связанного контакта.';
    } else {
      const contact =
        contactResponse.result || {};

      hasPhone =
        contactHasPhone(contact);

      if (!hasPhone) {
        reason =
          'У клиента не заполнен телефон. Заполните телефон в контакте из блока «Клиент».';
      }
    }
  }

  if (hasPhone) {
    return json({
      ok: true,
      allowed: true,
      leadId,
      contactId,
      statusId: currentStatusId,
    });
  }
/*
 * Контакт вообще не выбран —
 * причину отсутствия телефона использовать нельзя.
 * Лид должен вернуться в "Новый".
 */

if (!contactId) {

  reason =
    'В поле «Клиент» не выбран контакт. ' +
    'Сначала добавьте клиента.';

} else {

  /*
   * Контакт есть, но телефона нет.
   * Проверяем причину.
   */

  const reasonField =
    await findLeadUserFieldByTitle(
      domain,
      accessToken,
      NO_PHONE_REASON_FIELD_TITLE
    );


  if (!reasonField) {

    reason =
      'Не найдено поле «Почему не взяли контакт клиента?».';

  } else {

    const reasonFieldCode =
      String(
        reasonField.FIELD_NAME || ''
      ).trim();


    const noPhoneReason =
      lead[
        reasonFieldCode
      ];


    const hasNoPhoneReason =

      Array.isArray(
        noPhoneReason
      )
        ?
        noPhoneReason.length > 0

        :

        String(
          noPhoneReason || ''
        ).trim() !== '';


    /*
     * Причина заполнена —
     * разрешаем работать без телефона.
     */

    if (hasNoPhoneReason) {

      return json({
        ok: true,
        allowed: true,
        phoneMissing: true,
        reasonProvided: true,
        leadId,
        contactId,
        statusId:
          currentStatusId
      });
    }


    reason =
      'У клиента не заполнен телефон и не указана причина отсутствия контакта.';
  }
}
  /*
   * Телефона нет — возвращаем лид в "Новый".
   * Повторное ONCRMLEADUPDATE не зациклится:
   * на "Новый" обработчик сразу завершится.
   */
  const rollback = await restCall(
    domain,
    accessToken,
    'crm.lead.update',
    {
      id: leadId,
      fields: {
        STATUS_ID: newStatusId,
      },
    }
  );

  if (rollback.error) {
    return json({
      ok: false,
      error: 'rollback_failed',
      detail: rollback.error,
      reason,
    });
  }

  await addLeadTimelineComment(
    domain,
    accessToken,
    leadId,
    '⚠️ Лид возвращён в стадию «Новый». ' +
  reason +
  ' Заполните телефон либо поле ' +
  '«Почему не взяли контакт клиента?».'
  );

  return json({
    ok: true,
    allowed: false,
    rolledBack: true,
    leadId,
    contactId,
    fromStatusId: currentStatusId,
    toStatusId: newStatusId,
    reason,
  });
}
function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


async function getLeadMovementSnapshot(
  domain,
  accessToken,
  leadId,
  ignoredActivityId
) {

  const leadResponse =
    await restCall(
      domain,
      accessToken,
      'crm.lead.get',
      {
        id:
          leadId
      }
    );


  if (leadResponse.error) {

    throw new Error(
      'crm.lead.get: ' +
      (
        leadResponse.error_description
        ||
        leadResponse.error
      )
    );
  }


  const activityResponse =
    await restCall(
      domain,
      accessToken,
      'crm.activity.list',
      {

        order: {

          ID:
            'DESC'
        },


        filter: {

          OWNER_TYPE_ID:
            1,

          OWNER_ID:
            leadId
        },


        select: [

          'ID',
          'CREATED',
          'LAST_UPDATED',
          'SUBJECT',
          'TYPE_ID',
          'PROVIDER_ID',
          'PROVIDER_TYPE_ID'

        ],


        start:
          0
      }
    );


  if (activityResponse.error) {

    throw new Error(
      'crm.activity.list: ' +
      (
        activityResponse.error_description
        ||
        activityResponse.error
      )
    );
  }


  const activities =
    Array.isArray(
      activityResponse.result
    )
      ?
      activityResponse.result
      :
      [];


  /*
   * Сам тест-драйв исключаем.
   *
   * Иначе его собственное завершение
   * будет считаться новым действием.
   */

  const relevantActivities =
    activities.filter(
      function(item) {

        return (
          Number(
            item?.ID || 0
          )
          !==
          Number(
            ignoredActivityId || 0
          )
        );
      }
    );


  let maxActivityId =
    0;


  let latestActivityUpdated =
    '';


  for (
    const item
    of relevantActivities
  ) {

    const id =
      Number(
        item?.ID || 0
      );


    if (
      id > maxActivityId
    ) {

      maxActivityId =
        id;
    }


    const updated =
      String(
        item?.LAST_UPDATED
        ||
        item?.CREATED
        ||
        ''
      );


    if (
      updated >
      latestActivityUpdated
    ) {

      latestActivityUpdated =
        updated;
    }
  }


  const lead =
    leadResponse.result
    ||
    {};


  return {

    statusId:
      String(
        lead.STATUS_ID || ''
      ),

    maxActivityId:
      maxActivityId,

    latestActivityUpdated:
      latestActivityUpdated
  };
}


async function runTestDriveWatch(
  payload
) {

  const domain =
    String(
      payload.domain || ''
    );


  const accessToken =
    String(
      payload.accessToken || ''
    );


  const leadId =
    Number(
      payload.leadId || 0
    );


  const activityId =
    Number(
      payload.activityId || 0
    );


  /*
   * Сейчас максимум 25 секунд,
   * потому что это тестовый механизм
   * через waitUntil.
   */

  const delayMs =
    Math.min(
      Math.max(
        Number(
          payload.delayMs || 5000
        ),
        1000
      ),
      25000
    );


  if (
    !domain
    ||
    !accessToken
    ||
    !leadId
  ) {

    throw new Error(
      'Не хватает данных для контроля тест-драйва'
    );
  }


  /*
   * Даём Битриксу закончить
   * сохранение самого результата
   * тест-драйва.
   */

  await sleep(
    300
  );


  /*
   * Запоминаем состояние лида
   * сразу после тест-драйва.
   */

  const before =
    await getLeadMovementSnapshot(
      domain,
      accessToken,
      leadId,
      activityId
    );


  /*
   * ТЕСТ:
   * ждём 5 секунд.
   */

  await sleep(
    delayMs
  );


  /*
   * Проверяем ещё раз.
   */

  const after =
    await getLeadMovementSnapshot(
      domain,
      accessToken,
      leadId,
      activityId
    );


  /*
   * Считаем движением:
   *
   * 1. Изменилась стадия.
   * 2. Создалось новое дело.
   * 3. Изменилось существующее дело.
   *
   * Встреча, звонок, задача,
   * наше КП и т.п. являются CRM-делами.
   */

  const hasMovement =

    before.statusId
    !==
    after.statusId

    ||

    after.maxActivityId
    >
    before.maxActivityId

    ||

    after.latestActivityUpdated
    !==
    before.latestActivityUpdated;


  /*
   * Менеджер что-то сделал —
   * лид не трогаем.
   */

  if (
    hasMovement
  ) {

    return {

      movedToAbandoned:
        false,

      reason:
        'movement_detected',

      before:
        before,

      after:
        after
    };
  }


  /*
   * Ничего не произошло.
   * Ищем реальный ID стадии
   * "Брошенный".
   */

  const abandonedStatusId =
    await findLeadStatusIdByName(
      domain,
      accessToken,
      'Брошенный'
    );


  if (
    !abandonedStatusId
  ) {

    throw new Error(
      'Стадия «Брошенный» не найдена'
    );
  }


  /*
   * Отправляем лид в Брошенный.
   */

  const updateResponse =
    await restCall(
      domain,
      accessToken,
      'crm.lead.update',
      {

        id:
          leadId,


        fields: {

          STATUS_ID:
            abandonedStatusId
        }
      }
    );


  if (
    updateResponse.error
  ) {

    throw new Error(
      'crm.lead.update: ' +
      (
        updateResponse.error_description
        ||
        updateResponse.error
      )
    );
  }


  /*
   * Пишем причину в таймлайн.
   */

  await addLeadTimelineComment(
    domain,
    accessToken,
    leadId,

    '⚠️ После состоявшегося тест-драйва ' +
    'в течение 5 секунд по лиду не было новых действий. ' +
    'Лид автоматически переведён в стадию «Брошенный».'
  );


  return {

    movedToAbandoned:
      true,

    before:
      before,

    after:
      after
  };
}

async function assetResponse(env, request, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  url.search = '';

  const assetRequest = new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });

  const response = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(response.headers);

  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.delete('x-frame-options');
  headers.delete('content-security-policy');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env,ctx) {
    const requestUrl =
      new URL(request.url);

    if (
      requestUrl.hostname.endsWith(
        '.workers.dev'
      )
    ) {
      return proxyToServer(request);
    }
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    if (path === '/health.php' || path === '/health') {
      return json({
        ok: true,
        service: 'bitrix-crm-tools',
        platform: 'cloudflare-workers',
        time: new Date().toISOString(),
      });
    }

    if (path === '/activity-guard.php') {
      if (request.method !== 'POST') {
        return json({
          ok: true,
          endpoint: 'activity-guard',
        });
      }

      return activityGuard(request);
    }

    if (path === '/lead-phone-guard.php') {
      if (request.method !== 'POST') {
        return json({
          ok: true,
          endpoint: 'lead-phone-guard',
        });
      }

      return leadPhoneGuard(request);
    }
if (
  path ===
  '/testdrive-watch.php'
) {

  if (
    request.method
    !==
    'POST'
  ) {

    return json(
      {

        ok:
          true,

        endpoint:
          'testdrive-watch',

        testDelayMs:
          5000
      }
    );
  }


  let payload;


  try {

    payload =
      await request.json();

  } catch {

    return json(
      {

        ok:
          false,

        error:
          'bad_json'
      },

      400
    );
  }


  const task =
    runTestDriveWatch(
      payload
    )
      .catch(
        function(error) {

          console.error(
            'testdrive-watch:',
            error
          );
        }
      );


  ctx.waitUntil(
    task
  );


  return json(
    {

      ok:
        true,

      scheduled:
        true,

      delayMs:
        5000
    },

    202
  );
}

    // Старый диагностический обработчик больше не нужен.
    // Возвращаем 200, пока install.php удаляет старые события.
    if (
      path === '/lead-status-logger.php'
      ||
      path === '/diag-auth-save.php'
      ||
      path === '/lead-log-view.php'
    ) {
      return json({
        ok: true,
        disabled: true,
      });
    }

    const routes = {
      '/': '/index.html',
      '/index.php': '/index.html',
      '/index.html': '/index.html',
      '/install.php': '/install.html',
      '/install.html': '/install.html',
      '/call-result.php': '/call-result.html',
      '/call-result.html': '/call-result.html',
      '/testdrive.php': '/testdrive.html',
      '/testdrive.html': '/testdrive.html',
      '/commercial.php': '/commercial.html',
      '/commercial.html': '/commercial.html',

      '/call-plan.php': '/call-plan.html',
'/call-plan.html': '/call-plan.html',
      
      '/call-complete.php': '/call-complete.html',
      '/call-complete.html': '/call-complete.html',
    };

    const assetPath = routes[path];

    if (assetPath) {
      return assetResponse(env, request, assetPath);
    }

    return new Response('Not found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
      },
    });
  },
};
