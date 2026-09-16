// テスト用フィクスチャ：App 1080「電子申告依頼」の saveAfterStamp.js 相当
// スタンプ保存後に、外部アプリ App 1112「確定申告 受注･進捗･請求」を REST API で取得・更新する。
// 「電子申告実施日_*」は App 1112 側のフィールドであり、App 1080 には存在しない。
(function () {
  'use strict';
  const client = new KintoneRestAPIClient();

  kintone.events.on(['app.record.edit.submit.success', 'app.record.create.submit.success'], (event) => {
    const record = event.record;

    // --- 自アプリ（1080）のフィールド参照：従来どおり検出されるべき ---
    const customerName = record['得意先名'].value;
    const stamp = record.スタンプ画像.value;
    kintone.app.record.setFieldShown('承認者', true);
    // 自アプリに存在しないフィールド：「存在しない参照」として検出されるべき
    const legacy = record['旧_承認者'].value;

    const kodatoCode = record['コダトコード'].value;
    const date_syotoku = record['電子申告依頼日'].value;
    const date_syouhi = date_syotoku;
    const date_zouyo = date_syotoku;

    // --- 外部アプリ（1112）を REST API で取得 ---
    const getParams = {
      app: 1112,
      fields: [
        'レコード番号',
        'コダトコード',
        '得意先名',
        '電子申告実施日_所得税',
        '電子申告実施日_消費税',
        '電子申告実施日_贈与税'
      ],
      query: `コダトコード = "${kodatoCode}"`
    };

    return client.record.getRecords(getParams).then(function (response) {
      const kanryo_syotoku = response.records[0]['電子申告実施日_所得税'].value;
      const kanryo_syouhi = response.records[0]['電子申告実施日_消費税'].value;
      const kanryo_zouyo = response.records[0]['電子申告実施日_贈与税'].value;
      const upRecordId = response.records[0]['レコード番号'].value;

      // --- 外部アプリ（1112）を REST API で更新 ---
      const upParams = {
        app: 1112,
        id: upRecordId,
        record: {
          電子申告実施日_所得税: { value: date_syotoku },
          電子申告実施日_消費税: { value: date_syouhi },
          電子申告実施日_贈与税: { value: date_zouyo }
        }
      };
      return client.record.updateRecord(upParams);
    }).then(() => event);
  });

  // --- 自アプリを REST API で取得：app が kintone.app.getId() 由来なので自アプリ扱い ---
  kintone.events.on('app.record.index.show', (event) => {
    const appId = kintone.app.getId();
    const params = {
      app: appId,
      fields: ['コダトコード', '旧_進捗メモ'] // 旧_進捗メモ は自アプリに存在しない → 検出されるべき
    };
    return client.record.getRecords(params).then(() => event);
  });

  // --- app が変数で静的に特定できない場合：外部とも自アプリとも断定しない ---
  function syncOther() {
    const targetAppId = SOME_VARIABLE;
    const p = { app: targetAppId, fields: ['不明先_項目'] };
    return client.record.getRecords(p);
  }
})();
