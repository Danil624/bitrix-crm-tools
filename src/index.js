const ORIGIN_URL = 'https://kamaz-scrypt.taile47694.ts.net';

const CALL_RESULT_FIELD_TITLE = 'Результат звонка';
const NO_PHONE_REASON_FIELD_TITLE = 'Почему не взяли контакт клиента?';


/*
 * =========================================================
 * ПРОКСИ / БАЗОВЫЕ ОТВЕТЫ
 * =========================================================
 */

async function proxyToServer(request) {
  const incoming = new URL(request.url);

  const target = new URL(
    incoming.pathname + incoming.search,
    ORIGIN_URL
  );

  const headers = new Headers(request.headers);

  headers.delete('host');
  headers.delete('connection');
  headers.set('accept-encoding', 'identity');

  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');

  const options = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (
    request.method !== 'GET'
    &&
    request.method !== 'HEAD'
  ) {
    options.body = request.body;
  }

  const response = await fetch(
    target.toString(),
    options
  );

  const body = await response.arrayBuffer();

  const responseHeaders = new Headers(response.headers);

  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');
  responseHeaders.delete('connection');

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'cache-control': 'no-store',
      },
    }
  );
}


/*
 * =========================================================
 * ОБЩИЕ ФУНКЦИИ
 * =========================================================
 */

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}


function normalizeEntityType(value) {
  const type = String(value || '')
    .trim()
    .toUpperCase();

  if (
    type === 'DEAL'
    ||
    type === '2'
  ) {
    return 'DEAL';
  }

  if (
    type === 'LEAD'
    ||
    type === '1'
  ) {
    return 'LEAD';
  }

  return '';
}


function entityOwnerTypeId(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 2
    : 1;
}


function entityRestPrefix(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 'crm.deal'
    : 'crm.lead';
}


function entityTimelineType(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 'deal'
    : 'lead';
}


function entityName(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 'сделка'
    : 'лид';
}


function entityNameGenitive(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 'сделки'
    : 'лида';
}


function entityStageField(entityType) {
  return normalizeEntityType(entityType) === 'DEAL'
    ? 'STAGE_ID'
    : 'STATUS_ID';
}


function isEmptyEnumLabel(value) {
  const v = normalizeText(value);

  return [
    '',
    'не выбрано',
    'не выбран',
    'не выбрана',
    'не выбрано.',
  ].includes(v);
}


function callResultFilled(value, invalidIds) {
  if (Array.isArray(value)) {
    const values = value
      .map(v => String(v ?? '').trim())
      .filter(Boolean);

    return values.some(
      v => !invalidIds.includes(v)
    );
  }

  const v = String(value ?? '').trim();

  return (
    v !== ''
    &&
    !invalidIds.includes(v)
  );
}


function contactHasPhone(contact) {
  const phones = Array.isArray(contact?.PHONE)
    ? contact.PHONE
    : [];

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


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/*
 * =========================================================
 * BITRIX REST
 * =========================================================
 */

async function restCall(
  domain,
  accessToken,
  method,
  params = {}
) {
  const cleanDomain = String(domain || '')
    .replace(/^https?:\/\//i, '')
    .trim();

  if (
    !cleanDomain
    ||
    !accessToken
  ) {
    return {
      error: 'NO_AUTH',
      error_description: 'Нет данных авторизации Bitrix24',
    };
  }

  const response = await fetch(
    `https://${cleanDomain}/rest/${method}.json`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({
        ...params,
        auth: accessToken,
      }),
    }
  );

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


/*
 * =========================================================
 * CRM-ЭЛЕМЕНТ
 * =========================================================
 */

async function getCrmEntity(
  domain,
  accessToken,
  entityType,
  entityId
) {
  const type = normalizeEntityType(entityType);

  const response = await restCall(
    domain,
    accessToken,
    `${entityRestPrefix(type)}.get`,
    {
      id: Number(entityId),
    }
  );

  if (response.error) {
    return {
      ok: false,
      error: response.error,
      error_description: response.error_description,
      entity: null,
    };
  }

  return {
    ok: true,
    entity: response.result || {},
  };
}


async function updateCrmEntity(
  domain,
  accessToken,
  entityType,
  entityId,
  fields
) {
  return restCall(
    domain,
    accessToken,
    `${entityRestPrefix(entityType)}.update`,
    {
      id: Number(entityId),
      fields,
    }
  );
}


async function addTimelineComment(
  domain,
  accessToken,
  entityType,
  entityId,
  comment
) {
  return restCall(
    domain,
    accessToken,
    'crm.timeline.comment.add',
    {
      fields: {
        ENTITY_ID: Number(entityId),
        ENTITY_TYPE: entityTimelineType(entityType),
        COMMENT: comment,
      },
    }
  );
}


/*
 * =========================================================
 * ПОЛЬЗОВАТЕЛЬСКИЕ ПОЛЯ ЛИДА / СДЕЛКИ
 * =========================================================
 */

async function findUserFieldByTitle(
  domain,
  accessToken,
  entityType,
  title,
  options = {}
) {
  const type = normalizeEntityType(entityType);

  let start = 0;

  for (
    let page = 0;
    page < 20;
    page++
  ) {
    const filter = {
      LANG: 'ru',
    };

    if (options.enumerationOnly) {
      filter.USER_TYPE_ID = 'enumeration';
    }

    const response = await restCall(
      domain,
      accessToken,
      `${entityRestPrefix(type)}.userfield.list`,
      {
        order: {
          SORT: 'ASC',
          ID: 'ASC',
        },
        filter,
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
        if (
          label
          &&
          typeof label === 'object'
        ) {
          label = label.ru || '';
        }

        if (
          normalizeText(label)
          ===
          normalizeText(title)
        ) {
          found = true;
          break;
        }
      }

      if (!found) {
        continue;
      }

      if (
        Array.isArray(field.LIST)
        &&
        field.LIST.length
      ) {
        return field;
      }

      const fieldId = Number(
        field.ID || 0
      );

      if (fieldId > 0) {
        const getResponse = await restCall(
          domain,
          accessToken,
          `${entityRestPrefix(type)}.userfield.get`,
          {
            id: fieldId,
          }
        );

        if (
          !getResponse.error
          &&
          getResponse.result
        ) {
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

    start = Number(
      response.next || 0
    );
  }

  return null;
}


async function findCallResultField(
  domain,
  accessToken,
  entityType
) {
  return findUserFieldByTitle(
    domain,
    accessToken,
    entityType,
    CALL_RESULT_FIELD_TITLE,
    {
      enumerationOnly: true,
    }
  );
}


function invalidEnumIds(field) {
  const list = Array.isArray(field?.LIST)
    ? field.LIST
    : [];

  const invalid = [];

  for (const item of list) {
    const id = String(
      item?.ID ?? item?.id ?? ''
    );

    const value = String(
      item?.VALUE ?? item?.value ?? ''
    );

    if (
      id
      &&
      isEmptyEnumLabel(value)
    ) {
      invalid.push(id);
    }
  }

  return invalid;
}


/*
 * =========================================================
 * СТАДИИ ЛИДОВ / СДЕЛОК
 * =========================================================
 */

async function getLeadStages(
  domain,
  accessToken
) {
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


function dealStageEntityId(categoryId) {
  const category =
    Number(categoryId || 0);

  return category > 0
    ? `DEAL_STAGE_${category}`
    : 'DEAL_STAGE';
}


async function getDealStages(
  domain,
  accessToken,
  categoryId
) {
  const response = await restCall(
    domain,
    accessToken,
    'crm.status.list',
    {
      filter: {
        ENTITY_ID:
          dealStageEntityId(categoryId),
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


async function findStageIdByName(
  domain,
  accessToken,
  entityType,
  stageName,
  categoryId = 0
) {
  const type =
    normalizeEntityType(entityType);

  const stages =
    type === 'DEAL'
      ? await getDealStages(
          domain,
          accessToken,
          categoryId
        )
      : await getLeadStages(
          domain,
          accessToken
        );

  const target = stages.find(
    stage =>
      normalizeText(stage?.NAME)
      ===
      normalizeText(stageName)
  );

  return String(
    target?.STATUS_ID || ''
  );
}


/*
 * =========================================================
 * ОСНОВНОЙ КОНТАКТ ЛИДА / СДЕЛКИ
 * =========================================================
 */

async function getPrimaryEntityContact(
  domain,
  accessToken,
  entityType,
  entityId
) {
  const type =
    normalizeEntityType(entityType);

  const response = await restCall(
    domain,
    accessToken,
    `${entityRestPrefix(type)}.contact.items.get`,
    {
      id: Number(entityId),
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
      item =>
        String(
          item?.IS_PRIMARY || ''
        ).toUpperCase() === 'Y'
    )
    ||
    items[0];

  return {
    ok: true,
    contactId: Number(
      primary?.CONTACT_ID || 0
    ),
  };
}


/*
 * =========================================================
 * GUARD: НЕЛЬЗЯ ЗАКРЫТЬ ЗВОНОК БЕЗ РЕЗУЛЬТАТА
 * =========================================================
 */

async function activityGuard(request) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json(
      {
        ok: false,
        error: 'bad_form_data',
      },
      400
    );
  }

  const event = String(
    form.get('event') || ''
  ).toLowerCase();

  if (
    event !== 'oncrmactivityupdate'
  ) {
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

  const domain = String(
    form.get('auth[domain]') || ''
  );

  const accessToken = String(
    form.get('auth[access_token]') || ''
  );

  if (
    !activityId
    ||
    !domain
    ||
    !accessToken
  ) {
    return json({
      ok: false,
      error: 'missing_event_data',
    });
  }

  const activityResponse = await restCall(
    domain,
    accessToken,
    'crm.activity.get',
    {
      id: activityId,
    }
  );

  if (activityResponse.error) {
    return json({
      ok: false,
      error: 'activity_get_failed',
      detail: activityResponse.error,
    });
  }

  const activity =
    activityResponse.result || {};

  const typeId =
    Number(activity.TYPE_ID || 0);

  const ownerTypeId =
    Number(activity.OWNER_TYPE_ID || 0);

  const entityId =
    Number(activity.OWNER_ID || 0);

  const completed =
    String(
      activity.COMPLETED || 'N'
    ).toUpperCase();

  const entityType =
    ownerTypeId === 2
      ? 'DEAL'
      : (
          ownerTypeId === 1
            ? 'LEAD'
            : ''
        );

  if (
    typeId !== 2
    ||
    !entityType
    ||
    !entityId
    ||
    completed !== 'Y'
  ) {
    return json({
      ok: true,
      ignored:
        'not_completed_supported_crm_call',
    });
  }

  const entityResponse =
    await getCrmEntity(
      domain,
      accessToken,
      entityType,
      entityId
    );

  if (!entityResponse.ok) {
    return json({
      ok: false,
      error:
        `${entityType.toLowerCase()}_get_failed`,
    });
  }

  const entity =
    entityResponse.entity || {};

  const field =
    await findCallResultField(
      domain,
      accessToken,
      entityType
    );

  if (!field) {
    return json({
      ok: false,
      error: 'call_result_field_not_found',
      entityType,
      entityId,
    });
  }

  const fieldCode =
    String(
      field.FIELD_NAME || ''
    ).trim();

  if (!fieldCode) {
    return json({
      ok: false,
      error:
        'call_result_field_code_empty',
    });
  }

  const invalidIds =
    invalidEnumIds(field);

  const entityValue =
    entity[fieldCode];

  if (
    callResultFilled(
      entityValue,
      invalidIds
    )
  ) {
    return json({
      ok: true,
      allowed: true,
      entityType,
      entityId,
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
        OWNER_ID: entityId,
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

  await addTimelineComment(
    domain,
    accessToken,
    entityType,
    entityId,
    '⚠️ Звонок не завершён. Перед завершением заполните обязательное поле «Результат звонка» в карточке '
    +
    entityNameGenitive(entityType)
    +
    '.'
  );

  return json({
    ok: true,
    allowed: false,
    reopened: true,
    entityType,
    entityId,
    activityId,
  });
}


/*
 * =========================================================
 * GUARD: КОНТАКТ / ТЕЛЕФОН
 * Работает и для лида, и для сделки.
 * =========================================================
 */

async function crmPhoneGuard(request) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json(
      {
        ok: false,
        error: 'bad_form_data',
      },
      400
    );
  }

  const event =
    String(
      form.get('event') || ''
    ).toLowerCase();

  let entityType = '';

  if (
    event === 'oncrmdealupdate'
  ) {
    entityType = 'DEAL';
  }

  if (
    event === 'oncrmleadupdate'
  ) {
    entityType = 'LEAD';
  }

  if (!entityType) {
    return json({
      ok: true,
      ignored: 'wrong_event',
    });
  }

  const entityId = Number(
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

  if (
    !entityId
    ||
    !domain
    ||
    !accessToken
  ) {
    return json({
      ok: false,
      error: 'missing_event_data',
    });
  }

  const entityResponse =
    await getCrmEntity(
      domain,
      accessToken,
      entityType,
      entityId
    );

  if (!entityResponse.ok) {
    return json({
      ok: false,
      error: 'entity_get_failed',
      detail:
        entityResponse.error,
    });
  }

  const entity =
    entityResponse.entity || {};

  const categoryId =
    Number(
      entity.CATEGORY_ID || 0
    );

  const stageField =
    entityStageField(entityType);

  const currentStageId =
    String(
      entity[stageField] || ''
    );

  const newStageId =
    await findStageIdByName(
      domain,
      accessToken,
      entityType,
      'Новый',
      categoryId
    );

  if (!newStageId) {
    return json({
      ok: false,
      error: 'new_stage_not_found',
      entityType,
      categoryId,
    });
  }

  /*
   * На стадии "Новый" контакт/телефон
   * ещё можно заполнить.
   */

  if (
    currentStageId === newStageId
  ) {
    return json({
      ok: true,
      allowed: true,
      stage: 'new',
      entityType,
      entityId,
    });
  }

  const contactLink =
    await getPrimaryEntityContact(
      domain,
      accessToken,
      entityType,
      entityId
    );

  let contactId =
    Number(
      contactLink.contactId || 0
    );

  /*
   * Fallback.
   */

  if (!contactId) {
    contactId = Number(
      entity.CONTACT_ID || 0
    );
  }

  let reason = '';
  let hasPhone = false;

  if (!contactId) {
    reason =
      'В поле «Клиент» не выбран контакт. Добавьте контакт и заполните его телефон.';
  } else {
    const contactResponse =
      await restCall(
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
      entityType,
      entityId,
      contactId,
      stageId: currentStageId,
    });
  }

  /*
   * Контакт есть, но телефона нет.
   * Проверяем причину.
   */

  if (!contactId) {
    reason =
      'В поле «Клиент» не выбран контакт. Сначала добавьте клиента.';
  } else {
    const reasonField =
      await findUserFieldByTitle(
        domain,
        accessToken,
        entityType,
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
        entity[
          reasonFieldCode
        ];

      const hasNoPhoneReason =
        Array.isArray(
          noPhoneReason
        )
          ? noPhoneReason.length > 0
          : String(
              noPhoneReason || ''
            ).trim() !== '';

      if (hasNoPhoneReason) {
        return json({
          ok: true,
          allowed: true,
          phoneMissing: true,
          reasonProvided: true,
          entityType,
          entityId,
          contactId,
          stageId: currentStageId,
        });
      }

      reason =
        'У клиента не заполнен телефон и не указана причина отсутствия контакта.';
    }
  }

  /*
   * Возвращаем в "Новый".
   */

  const rollback =
    await updateCrmEntity(
      domain,
      accessToken,
      entityType,
      entityId,
      {
        [stageField]:
          newStageId,
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

  await addTimelineComment(
    domain,
    accessToken,
    entityType,
    entityId,
    '⚠️ '
    +
    (
      entityType === 'DEAL'
        ? 'Сделка возвращена'
        : 'Лид возвращён'
    )
    +
    ' в стадию «Новый». '
    +
    reason
    +
    ' Заполните телефон либо поле «Почему не взяли контакт клиента?».'
  );

  return json({
    ok: true,
    allowed: false,
    rolledBack: true,
    entityType,
    entityId,
    contactId,
    fromStageId: currentStageId,
    toStageId: newStageId,
    reason,
  });
}


/*
 * =========================================================
 * КОНТРОЛЬ ПОСЛЕ ТЕСТ-ДРАЙВА
 * =========================================================
 */

async function getCrmMovementSnapshot(
  domain,
  accessToken,
  entityType,
  entityId,
  ignoredActivityId
) {
  const type =
    normalizeEntityType(entityType);

  const entityResponse =
    await getCrmEntity(
      domain,
      accessToken,
      type,
      entityId
    );

  if (!entityResponse.ok) {
    throw new Error(
      `${entityRestPrefix(type)}.get: `
      +
      (
        entityResponse.error_description
        ||
        entityResponse.error
        ||
        'unknown_error'
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
          ID: 'DESC',
        },

        filter: {
          OWNER_TYPE_ID:
            entityOwnerTypeId(type),

          OWNER_ID:
            Number(entityId),
        },

        select: [
          'ID',
          'CREATED',
          'LAST_UPDATED',
          'SUBJECT',
          'TYPE_ID',
          'PROVIDER_ID',
          'PROVIDER_TYPE_ID',
        ],

        start:
          0,
      }
    );

  if (activityResponse.error) {
    throw new Error(
      'crm.activity.list: '
      +
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
      ? activityResponse.result
      : [];

  const relevantActivities =
    activities.filter(
      function (item) {
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

  let maxActivityId = 0;
  let latestActivityUpdated = '';

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
      maxActivityId = id;
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

  const entity =
    entityResponse.entity || {};

  const stageField =
    entityStageField(type);

  return {
    stageId:
      String(
        entity[stageField] || ''
      ),

    categoryId:
      Number(
        entity.CATEGORY_ID || 0
      ),

    maxActivityId:
      maxActivityId,

    latestActivityUpdated:
      latestActivityUpdated,
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

  let entityType =
    normalizeEntityType(
      payload.entityType
    );

  if (!entityType) {
    if (
      Number(
        payload.dealId || 0
      ) > 0
    ) {
      entityType = 'DEAL';
    } else {
      entityType = 'LEAD';
    }
  }

  const entityId =
    Number(
      payload.entityId
      ||
      (
        entityType === 'DEAL'
          ? payload.dealId
          : payload.leadId
      )
      ||
      0
    );

  const activityId =
    Number(
      payload.activityId || 0
    );

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
    !entityId
  ) {
    throw new Error(
      'Не хватает данных для контроля тест-драйва'
    );
  }

  await sleep(
    300
  );

  const before =
    await getCrmMovementSnapshot(
      domain,
      accessToken,
      entityType,
      entityId,
      activityId
    );

  await sleep(
    delayMs
  );

  const after =
    await getCrmMovementSnapshot(
      domain,
      accessToken,
      entityType,
      entityId,
      activityId
    );

  const hasMovement =
    before.stageId
    !==
    after.stageId

    ||

    after.maxActivityId
    >
    before.maxActivityId

    ||

    after.latestActivityUpdated
    !==
    before.latestActivityUpdated;

  if (hasMovement) {
    return {
      movedToAbandoned:
        false,

      reason:
        'movement_detected',

      entityType,
      entityId,

      before,
      after,
    };
  }

  const categoryId =
    Number(
      after.categoryId
      ||
      before.categoryId
      ||
      0
    );

  const abandonedStageId =
    await findStageIdByName(
      domain,
      accessToken,
      entityType,
      'Брошенный',
      categoryId
    );

  if (!abandonedStageId) {
    throw new Error(
      'Стадия «Брошенный» не найдена'
    );
  }

  const stageField =
    entityStageField(entityType);

  const updateResponse =
    await updateCrmEntity(
      domain,
      accessToken,
      entityType,
      entityId,
      {
        [stageField]:
          abandonedStageId,
      }
    );

  if (updateResponse.error) {
    throw new Error(
      `${entityRestPrefix(entityType)}.update: `
      +
      (
        updateResponse.error_description
        ||
        updateResponse.error
      )
    );
  }

  await addTimelineComment(
    domain,
    accessToken,
    entityType,
    entityId,
    '⚠️ После состоявшегося тест-драйва '
    +
    'в течение '
    +
    Math.round(delayMs / 1000)
    +
    ' сек. по '
    +
    (
      entityType === 'DEAL'
        ? 'сделке'
        : 'лиду'
    )
    +
    ' не было новых действий. '
    +
    (
      entityType === 'DEAL'
        ? 'Сделка автоматически переведена'
        : 'Лид автоматически переведён'
    )
    +
    ' в стадию «Брошенный».'
  );

  return {
    movedToAbandoned:
      true,

    entityType,
    entityId,

    before,
    after,
  };
}


/*
 * =========================================================
 * STATIC ASSETS
 * =========================================================
 */

async function assetResponse(
  env,
  request,
  assetPath
) {
  const url =
    new URL(request.url);

  url.pathname =
    assetPath;

  url.search =
    '';

  const assetRequest =
    new Request(
      url.toString(),
      {
        method: 'GET',
        headers: request.headers,
      }
    );

  const response =
    await env.ASSETS.fetch(
      assetRequest
    );

  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    'cache-control',
    'no-store, no-cache, must-revalidate'
  );

  headers.delete(
    'x-frame-options'
  );

  headers.delete(
    'content-security-policy'
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}


/*
 * =========================================================
 * WORKER
 * =========================================================
 */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const requestUrl =
      new URL(
        request.url
      );


    /*
     * workers.dev больше не используем как
     * основной адрес приложения.
     */

    if (
      requestUrl.hostname.endsWith(
        '.workers.dev'
      )
    ) {

      const target =
        new URL(
          requestUrl.pathname
          +
          requestUrl.search,
          ORIGIN_URL
        );

      return Response.redirect(
        target.toString(),
        302
      );
    }


    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname
        .toLowerCase();


    /*
     * HEALTH
     */

    if (
      path === '/health.php'
      ||
      path === '/health'
    ) {

      return json({
        ok: true,
        service: 'bitrix-crm-tools',
        platform: 'cloudflare-workers',
        time: new Date().toISOString(),
      });
    }


    /*
     * ЗВОНОК НЕЛЬЗЯ ЗАКРЫТЬ
     * БЕЗ РЕЗУЛЬТАТА
     */

    if (
      path === '/activity-guard.php'
    ) {

      if (
        request.method !== 'POST'
      ) {

        return json({
          ok: true,
          endpoint: 'activity-guard',
          supports: [
            'LEAD',
            'DEAL',
          ],
        });
      }

      return activityGuard(
        request
      );
    }


    /*
     * ПРОВЕРКА КОНТАКТА / ТЕЛЕФОНА
     */

    if (
      path === '/lead-phone-guard.php'
      ||
      path === '/crm-phone-guard.php'
      ||
      path === '/deal-phone-guard.php'
    ) {

      if (
        request.method !== 'POST'
      ) {

        return json({
          ok: true,
          endpoint: 'crm-phone-guard',
          supports: [
            'ONCRMLEADUPDATE',
            'ONCRMDEALUPDATE',
          ],
        });
      }

      return crmPhoneGuard(
        request
      );
    }


    /*
     * КОНТРОЛЬ ПОСЛЕ ТЕСТ-ДРАЙВА
     */

    if (
      path === '/testdrive-watch.php'
    ) {

      if (
        request.method !== 'POST'
      ) {

        return json({
          ok: true,
          endpoint:
            'testdrive-watch',
          testDelayMs:
            5000,
          supports: [
            'LEAD',
            'DEAL',
          ],
        });
      }


      let payload;

      try {

        payload =
          await request.json();

      } catch {

        return json(
          {
            ok: false,
            error: 'bad_json',
          },
          400
        );
      }


      const task =
        runTestDriveWatch(
          payload
        )
        .catch(
          function (error) {

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
          ok: true,
          scheduled: true,
          entityType:
            normalizeEntityType(
              payload.entityType
            )
            ||
            (
              Number(
                payload.dealId || 0
              ) > 0
                ? 'DEAL'
                : 'LEAD'
            ),
          entityId:
            Number(
              payload.entityId
              ||
              payload.dealId
              ||
              payload.leadId
              ||
              0
            ),
          delayMs:
            Math.min(
              Math.max(
                Number(
                  payload.delayMs || 5000
                ),
                1000
              ),
              25000
            ),
        },
        202
      );
    }


    /*
     * СТАРЫЕ ДИАГНОСТИЧЕСКИЕ ENDPOINTS
     */

    if (
      path === '/lead-status-logger.php'
      ||
      path === '/deal-status-logger.php'
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


    /*
     * HTML
     */

    const routes = {

      '/':
        '/index.html',

      '/index.php':
        '/index.html',

      '/index.html':
        '/index.html',

      '/install.php':
        '/install.html',

      '/install.html':
        '/install.html',

      '/call-result.php':
        '/call-result.html',

      '/call-result.html':
        '/call-result.html',

      '/testdrive.php':
        '/testdrive.html',

      '/testdrive.html':
        '/testdrive.html',

      '/commercial.php':
        '/commercial.html',

      '/commercial.html':
        '/commercial.html',

      '/call-plan.php':
        '/call-plan.html',

      '/call-plan.html':
        '/call-plan.html',

      '/call-complete.php':
        '/call-complete.html',

      '/call-complete.html':
        '/call-complete.html',

    };


    const assetPath =
      routes[path];


    if (
      assetPath
    ) {

      return assetResponse(
        env,
        request,
        assetPath
      );
    }


    return new Response(
      'Not found',
      {
        status: 404,
        headers: {
          'content-type':
            'text/plain; charset=UTF-8',
        },
      }
    );
  },
};
