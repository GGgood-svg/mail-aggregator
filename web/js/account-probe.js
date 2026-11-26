'use strict';

window.AccountProbe = (() => {
  const keys = ['test','plan','explain','start','working','close','source','target','passed','notChecked','count','credentials','auth','network','tls','list','limit','stale','busy','timeout','failed','estimate','legacy','mirror','from','to','action','use','create','skip','conflict','subscribe','more','queue','queued','confirm','expired','root','stop'];
  const packs = {
    'zh-CN': ['测试连接（只读）','预览同步影响','检查两端的连接、认证和文件夹列表，不修改邮件、目录或订阅。写入权限不在此处验证。','开始检查','正在检查…','关闭','源邮箱','本地目标邮箱','读取成功','未检查','可见文件夹','缺少凭据或需要重新授权','认证失败，请检查凭据','无法连接或验证服务器地址','TLS 证书或加密连接验证失败','无法读取文件夹列表','文件夹超过检查上限','配置已变化，请重新检查','同步、维护或授权刷新正在进行，请稍后重试','连接或读取超时','检查未完成','这是基于当前文件夹和策略的估算。启动同步前请核对结果。','旧目标目录无法可靠预览，请先检查配置。','镜像策略可能删除下列目标文件夹中的邮件。','源文件夹','目标文件夹','预计操作','使用现有目录','可能创建','跳过','有冲突','可能订阅','仅显示前 100 个文件夹。','按这份预览发起同步','已加入同步队列','确认按当前配置开始同步？','预览已过期或配置已变化，请重新检查。','可能创建账号的根文件夹。','取消检查'],
    'en-US': ['Test connection (read only)','Preview sync impact','Checks connections, authentication and folder lists on both ends. It leaves messages, folders and subscriptions unchanged. Write access is not tested.','Start check','Checking…','Close','Source mailbox','Destination mailbox','Read succeeded','Not checked','Visible folders','Credentials missing or authorization required','Authentication failed; check the credentials','Could not reach or validate the server','Certificate or TLS verification failed','Could not list folders','Folder list exceeds the check limit','Settings changed; run the check again','Sync, maintenance or authorization refresh is in progress. Try again shortly.','Connection or listing timed out','Check did not finish','This estimate uses the current folders and settings. Review it before starting sync.','This legacy destination cannot be previewed reliably. Check its settings first.','Mirroring may delete messages in the destination folders shown below.','Source folder','Destination folder','Expected action','Use existing','May create','Skip','Conflict','May subscribe','Only the first 100 folders are shown.','Queue sync from this preview','Sync queued','Start sync with these settings?','The preview expired or settings changed. Run the check again.','The account root folder may be created.','Cancel check'],
    'de-DE': ['Verbindung testen (nur Lesen)','Synchronisierungsvorschau','Prüft Verbindung, Anmeldung und Ordnerlisten beider Seiten. Nachrichten, Ordner und Abonnements bleiben unverändert. Schreibrechte werden nicht geprüft.','Prüfung starten','Prüfung läuft…','Schließen','Quellpostfach','Zielpostfach','Lesen erfolgreich','Nicht geprüft','Sichtbare Ordner','Zugangsdaten fehlen oder Autorisierung erforderlich','Anmeldung fehlgeschlagen','Server nicht erreichbar oder prüfbar','TLS- oder Zertifikatsprüfung fehlgeschlagen','Ordnerliste nicht lesbar','Zu viele Ordner für diese Prüfung','Konfiguration geändert. Erneut prüfen.','Synchronisierung, Wartung oder Autorisierung läuft. Bitte warten.','Zeitlimit überschritten','Prüfung nicht abgeschlossen','Schätzung anhand der aktuellen Ordner und Einstellungen. Vor der Synchronisierung prüfen.','Für dieses alte Ziel ist keine zuverlässige Vorschau möglich. Einstellungen prüfen.','Spiegelung kann Nachrichten in den folgenden Zielordnern löschen.','Quellordner','Zielordner','Erwartete Aktion','Vorhandenen nutzen','Eventuell anlegen','Überspringen','Konflikt','Eventuell abonnieren','Nur die ersten 100 Ordner werden angezeigt.','Synchronisierung aus dieser Vorschau starten','Synchronisierung hinzugefügt','Synchronisierung mit diesen Einstellungen starten?','Vorschau abgelaufen oder Einstellungen geändert. Erneut prüfen.','Der Hauptordner des Kontos wird eventuell erstellt.','Prüfung abbrechen'],
    'es-ES': ['Probar conexión (solo lectura)','Prever el impacto','Comprueba la conexión, la autenticación y las carpetas de ambos buzones. No cambia mensajes, carpetas ni suscripciones. No comprueba permisos de escritura.','Iniciar comprobación','Comprobando…','Cerrar','Buzón de origen','Buzón de destino','Lectura correcta','Sin comprobar','Carpetas visibles','Faltan credenciales o autorización','Error de autenticación; revisa las credenciales','No se pudo conectar o validar el servidor','Falló la verificación TLS o del certificado','No se pudieron listar las carpetas','Demasiadas carpetas para la comprobación','La configuración cambió. Vuelve a comprobar.','Sincronización, mantenimiento o autorización en curso. Inténtalo más tarde.','Se agotó el tiempo de espera','Comprobación incompleta','Estimación basada en las carpetas y ajustes actuales. Revísala antes de sincronizar.','No se puede previsualizar de forma fiable este destino antiguo. Revisa sus ajustes.','La función de espejo puede borrar mensajes de las carpetas de destino indicadas.','Carpeta de origen','Carpeta de destino','Acción prevista','Usar existente','Puede crear','Omitir','Conflicto','Puede suscribir','Solo se muestran las primeras 100 carpetas.','Poner en cola desde esta vista','Sincronización en cola','¿Iniciar con estos ajustes?','La vista caducó o cambiaron los ajustes. Comprueba de nuevo.','Puede crearse la carpeta raíz de la cuenta.','Cancelar comprobación'],
    'fr-FR': ['Tester (lecture seule)','Aperçu de la synchronisation','Vérifie les connexions, l’authentification et les dossiers des deux boîtes. Ne change aucun message, dossier ni abonnement. Les droits d’écriture ne sont pas testés.','Lancer la vérification','Vérification…','Fermer','Boîte source','Boîte de destination','Lecture réussie','Non vérifié','Dossiers visibles','Identifiants ou autorisation nécessaires','Échec de l’authentification','Serveur inaccessible ou non vérifiable','Échec de la vérification TLS ou du certificat','Liste des dossiers indisponible','Trop de dossiers pour cette vérification','Configuration modifiée. Relancez la vérification.','Synchronisation, maintenance ou autorisation en cours. Réessayez plus tard.','Délai dépassé','Vérification incomplète','Estimation fondée sur les dossiers et les réglages actuels. Vérifiez-la avant de synchroniser.','Impossible de prévoir ce que fera cette ancienne destination. Vérifiez ses réglages.','Le mode miroir peut supprimer des messages dans les dossiers de destination indiqués.','Dossier source','Dossier de destination','Action prévue','Utiliser l’existant','Création possible','Ignorer','Conflit','Abonnement possible','Seuls les 100 premiers dossiers sont affichés.','Mettre en file depuis cet aperçu','Synchronisation en attente','Lancer avec ces réglages ?','L’aperçu a expiré ou les réglages ont changé. Recommencez.','Le dossier racine du compte peut être créé.','Annuler la vérification'],
    'ja-JP': ['接続テスト（読み取り専用）','同期の影響を確認','両方の接続、認証、フォルダー一覧を確認します。メール、フォルダー、購読は変更しません。書き込み権限は確認しません。','確認を開始','確認中…','閉じる','同期元メールボックス','同期先メールボックス','読み取り成功','未確認','表示可能なフォルダー','認証情報の設定または再認証が必要です','認証に失敗しました','サーバーに接続できないか検証できません','TLS または証明書の検証に失敗しました','フォルダー一覧を取得できません','フォルダーが確認の上限を超えています','設定が変わりました。再確認してください。','同期、保守、または認証更新中です。しばらくして再試行してください。','接続または読み取りがタイムアウトしました','確認が完了しませんでした','現在のフォルダーと設定に基づく見積もりです。同期を開始する前に確認してください。','旧形式の同期先は正確に予測できません。設定を確認してください。','ミラー同期では、以下の同期先フォルダーからメールが削除されることがあります。','同期元フォルダー','同期先フォルダー','予想される操作','既存を使用','作成の可能性','スキップ','競合','購読の可能性','最初の 100 フォルダーのみ表示します。','この内容で同期を予約','同期を予約しました','この設定で同期を開始しますか？','プレビューの期限切れ、または設定が変わりました。再確認してください。','アカウントのルートフォルダーが作成される可能性があります。','確認をキャンセル'],
    'ko-KR': ['연결 테스트(읽기 전용)','동기화 영향 미리보기','양쪽의 연결, 인증, 폴더 목록을 확인합니다. 메시지, 폴더, 구독은 바꾸지 않습니다. 쓰기 권한은 검사하지 않습니다.','검사 시작','확인 중…','닫기','원본 사서함','대상 사서함','읽기 성공','확인하지 않음','볼 수 있는 폴더','자격 증명 또는 재인증 필요','인증에 실패했습니다','서버에 연결하거나 확인할 수 없습니다','TLS 또는 인증서 검증에 실패했습니다','폴더 목록을 읽을 수 없습니다','폴더 수가 검사 한도를 넘었습니다','설정이 변경되었습니다. 다시 확인하세요.','동기화, 유지 관리 또는 인증 갱신 중입니다. 잠시 후 다시 시도하세요.','연결하거나 읽는 시간이 초과되었습니다','검사가 완료되지 않았습니다','현재 폴더와 설정에 따른 예상입니다. 동기화 전에 검토하세요.','기존 방식의 대상은 안정적으로 미리볼 수 없습니다. 설정을 확인하세요.','미러 동기화는 아래 대상 폴더의 메일을 삭제할 수 있습니다.','원본 폴더','대상 폴더','예상 작업','기존 폴더 사용','생성 가능','건너뛰기','충돌','구독 가능','처음 100개 폴더만 표시합니다.','이 미리보기로 동기화 예약','동기화가 예약되었습니다','이 설정으로 동기화할까요?','미리보기가 만료되었거나 설정이 변경되었습니다. 다시 확인하세요.','계정 루트 폴더가 생성될 수 있습니다.','검사 취소'],
  };
  const pageLabels = {
    'zh-CN': ['上一批','下一批','镜像可能删除目标邮件，尚未显示的目录也可能受影响。','可能删除邮件','服务器目录列表超过读取上限。可以改为只检查所选源目录。','服务器目录列表读取超时。可以重试，或只检查所选源目录。','预演结果超过上限，请缩小同步范围后重试。'],
    'en-US': ['Previous folders','Next folders','Mirroring may delete destination messages, including in folders not shown yet.','May delete messages','The server folder list exceeded the read limit. You can check a smaller source range.','Reading the server folder list timed out. Retry or check a smaller source range.','The preview is too large. Narrow the sync scope and try again.'],
    'de-DE': ['Vorherige Ordner','Weitere Ordner','Die Spiegelung kann Zielnachrichten auch in noch nicht angezeigten Ordnern löschen.','Kann Nachrichten löschen','Die Ordnerliste überschreitet das Leselimit. Sie können einen kleineren Quellbereich prüfen.','Zeitlimit beim Lesen der Ordnerliste. Versuchen Sie es erneut oder prüfen Sie einen kleineren Quellbereich.','Die Vorschau ist zu groß. Schränken Sie den Synchronisationsumfang ein.'],
    'es-ES': ['Carpetas anteriores','Carpetas siguientes','El modo espejo puede borrar mensajes del destino, incluso en carpetas aún no mostradas.','Puede borrar mensajes','La lista del servidor supera el límite de lectura. Puedes comprobar un ámbito de origen más pequeño.','Se agotó el tiempo de lectura de la lista. Reintenta o comprueba un ámbito de origen más pequeño.','La vista previa es demasiado grande. Reduce el alcance de la sincronización y vuelve a intentarlo.'],
    'fr-FR': ['Dossiers précédents','Dossiers suivants','La mise en miroir peut supprimer des messages de destination, y compris dans les dossiers pas encore affichés.','Peut supprimer des messages','La liste du serveur dépasse la limite de lecture. Vous pouvez vérifier un périmètre source plus restreint.','La lecture de la liste a expiré. Réessayez ou vérifiez un périmètre source plus restreint.','L’aperçu est trop volumineux. Réduisez le périmètre de synchronisation et réessayez.'],
    'ja-JP': ['前のフォルダー','次のフォルダー','ミラー同期では、未表示のフォルダーでも同期先のメールが削除されることがあります。','メールを削除する可能性あり','サーバーの一覧が読み取り上限を超えました。同期元の範囲を絞って確認できます。','フォルダー一覧の読み取りがタイムアウトしました。再試行するか、同期元の範囲を絞って確認してください。','プレビューが大きすぎます。同期範囲を絞って再試行してください。'],
    'ko-KR': ['이전 폴더','다음 폴더','미러 동기화는 아직 표시되지 않은 폴더의 대상 메일도 삭제할 수 있습니다.','메일 삭제 가능','서버 폴더 목록이 읽기 한도를 넘었습니다. 더 좁은 원본 범위를 확인할 수 있습니다.','폴더 목록을 읽는 시간이 초과되었습니다. 다시 시도하거나 원본 범위를 좁혀 확인하세요.','미리보기가 너무 큽니다. 동기화 범위를 줄이고 다시 시도하세요.'],
  };
  const pageKeys = ['previous', 'next', 'mirrorAll', 'deleteMessages', 'plan_list_limit', 'plan_list_timeout', 'plan_limit'];
  const scopeKeys = ['scopeTitle','scopeNote','scopeKind','scopeExact','scopeRoot','scopeChildren','scopePath','scopeRun','scopeBrowse','scopeEmpty','plan_scope_invalid','plan_scope_flat','plan_scope_missing','plan_scope_limit'];
  const scopeLabels = {
    'zh-CN': ['按源目录检查','只显示所选源目录范围。未检查目标，无法判断整体同步或镜像影响。','查询方式','精确目录','根目录一层','父目录下一层','源目录的完整名称','检查所选范围','展开一层','该范围内没有匹配的源目录。','请输入完整目录名，不能包含 *、% 或控制字符。','服务器未提供可用的目录层级，请改用精确名称。','找不到指定的父目录，请核对完整名称。','所选范围过大，请输入更具体的源目录名称。'],
    'en-US': ['Check a source folder range','Only the selected source range is shown. The destination and overall sync or mirror effects are unknown.','Query type','Exact folder','Top level','One level below a folder','Full source folder name','Check selected range','Check children','No source folders matched this range.','Enter a full folder name without *, % or control characters.','The server did not provide a usable hierarchy. Try an exact name.','The parent folder was not found. Check its full name.','This range is too large. Enter a more specific folder name.'],
    'de-DE': ['Quellordnerbereich prüfen','Angezeigt wird nur der gewählte Quellbereich. Ziel und Auswirkungen der Synchronisation oder Spiegelung sind unbekannt.','Abfragetyp','Genauer Ordner','Oberste Ebene','Eine Ebene unter einem Ordner','Vollständiger Quellordnername','Gewählten Bereich prüfen','Unterordner prüfen','Keine passenden Quellordner in diesem Bereich.','Geben Sie einen vollständigen Ordnernamen ohne *, % oder Steuerzeichen ein.','Der Server meldet keine nutzbare Ordnerhierarchie. Versuchen Sie einen genauen Namen.','Der übergeordnete Ordner wurde nicht gefunden. Prüfen Sie seinen vollständigen Namen.','Der Bereich ist zu groß. Geben Sie einen genaueren Ordnernamen ein.'],
    'es-ES': ['Comprobar un ámbito de origen','Solo se muestra el ámbito de origen elegido. Se desconocen el destino y el efecto global de la sincronización o del modo espejo.','Tipo de consulta','Carpeta exacta','Nivel superior','Un nivel debajo de una carpeta','Nombre completo de la carpeta de origen','Comprobar ámbito','Comprobar subcarpetas','No se encontraron carpetas de origen en este ámbito.','Introduce el nombre completo sin *, % ni caracteres de control.','El servidor no ofrece una jerarquía utilizable. Prueba con un nombre exacto.','No se encontró la carpeta superior. Comprueba su nombre completo.','Este ámbito es demasiado grande. Introduce un nombre de carpeta más específico.'],
    'fr-FR': ['Vérifier des dossiers source','Seul le périmètre source choisi est affiché. La destination et les effets globaux de la synchronisation ou du miroir restent inconnus.','Type de recherche','Dossier exact','Premier niveau','Un niveau sous un dossier','Nom complet du dossier source','Vérifier le périmètre','Vérifier les sous-dossiers','Aucun dossier source ne correspond.','Saisissez le nom complet sans *, % ni caractère de contrôle.','Le serveur ne fournit pas de hiérarchie exploitable. Essayez un nom exact.','Le dossier parent est introuvable. Vérifiez son nom complet.','Le périmètre est trop large. Saisissez un nom de dossier plus précis.'],
    'ja-JP': ['同期元フォルダーの範囲を確認','選択した同期元の範囲のみ表示します。同期先や同期・ミラー全体への影響は不明です。','検索方法','フォルダー名の完全一致','最上位のみ','親フォルダーの直下','同期元フォルダーの完全な名前','選択した範囲を確認','直下を確認','一致する同期元フォルダーはありません。','*、%、制御文字を含まない完全なフォルダー名を入力してください。','サーバーから有効な階層情報を取得できません。完全な名前で検索してください。','親フォルダーが見つかりません。完全な名前を確認してください。','範囲が広すぎます。より具体的なフォルダー名を入力してください。'],
    'ko-KR': ['원본 폴더 범위 확인','선택한 원본 범위만 표시합니다. 대상과 전체 동기화 또는 미러의 영향은 알 수 없습니다.','조회 방식','정확한 폴더','최상위 한 단계','부모 폴더 바로 아래','원본 폴더의 전체 이름','선택한 범위 확인','하위 폴더 확인','이 범위에 일치하는 원본 폴더가 없습니다.','*, % 또는 제어 문자가 없는 전체 폴더 이름을 입력하세요.','서버가 사용할 수 있는 폴더 계층을 제공하지 않았습니다. 정확한 이름을 사용하세요.','부모 폴더를 찾지 못했습니다. 전체 이름을 확인하세요.','범위가 너무 큽니다. 더 구체적인 폴더 이름을 입력하세요.'],
  };
  const reasonLabels = { credential_missing: 'credentials', authorization_required: 'credentials', auth_failed: 'auth',
    endpoint_rejected: 'network', network_unreachable: 'network', oauth_network: 'network', tls_failed: 'tls',
    folder_failed: 'list', folder_limit: 'limit', config_changed: 'stale', busy: 'busy', maintenance: 'busy', oauth_busy: 'busy', timeout: 'timeout' };
  const label = key => (packs[window.I18n?.locale] || packs['zh-CN'])[keys.indexOf(key)]
    || (pageLabels[window.I18n?.locale] || pageLabels['zh-CN'])[pageKeys.indexOf(key)]
    || (scopeLabels[window.I18n?.locale] || scopeLabels['zh-CN'])[scopeKeys.indexOf(key)] || key;
  const reason = code => label(reasonLabels[code] || ([...pageKeys,...scopeKeys].includes(code) ? code : 'failed'));
  const canScope = result => [result.category, result.source?.reason, result.target?.reason]
    .some(code => ['plan_list_limit','plan_list_timeout','timeout'].includes(code));

  function open(mode, accountId, { onQueued, confirmUnknown } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'mail-dialog'; dialog.setAttribute('data-i18n-skip', '');
    dialog.setAttribute('aria-label', label(mode));
    const node = (tag, text, parent = dialog) => {
      const element = document.createElement(tag); if (text) element.textContent = text; parent.append(element); return element;
    };
    const button = (text, action, parent, secondary = false) => {
      const item = node('button', text, parent); item.type = 'button'; item.className = `btn${secondary ? ' secondary' : ''}`;
      item.addEventListener('click', action); return item;
    };
    const controller = new AbortController();
    dialog.addEventListener('close', () => { controller.abort(); dialog.remove(); }, { once: true });
    node('h2', label(mode)); node('p', label('explain'));
    const output = node('div'); output.setAttribute('aria-live', 'polite');
    const buttons = node('p');
    const planUrl = `/api/accounts/${encodeURIComponent(accountId)}/sync-plan`;
    function offerSourceScope() {
      const section = node('section', null, output);
      node('h3', label('scopeTitle'), section);
      node('p', label('scopeNote'), section);
      const form = node('form', null, section);
      const modeLabel = node('label', label('scopeKind'), node('p', null, form));
      const kind = node('select', null, modeLabel);
      for (const [value, key] of [['exact','scopeExact'],['root','scopeRoot'],['children','scopeChildren']]) {
        node('option', label(key), kind).value = value;
      }
      const pathRow = node('p', null, form);
      const field = node('label', label('scopePath'), pathRow);
      const path = node('input', null, field); path.type = 'text'; path.maxLength = 1024; path.required = true;
      const run = node('button', label('scopeRun'), node('p', null, form)); run.className = 'btn secondary'; run.type = 'submit';
      const status = node('p', null, section); status.setAttribute('role', 'status');
      const listing = node('ul', null, section);
      const switchKind = () => { pathRow.hidden = path.disabled = kind.value === 'root'; };
      kind.addEventListener('change', switchKind);
      async function readScope() {
        if (run.disabled) return;
        const scope = kind.value === 'root' ? { kind: 'root' } : { kind: kind.value, path: path.value };
        status.textContent = label('working'); listing.replaceChildren();
        action.disabled = run.disabled = true; close.textContent = label('stop');
        try {
          const answer = await Api.post(planUrl, { scope }, { signal: controller.signal });
          if (!answer || controller.signal.aborted || !output.contains(section)) return;
          if (answer.plan?.status !== 'partial') { status.textContent = reason(answer.source?.reason || answer.category); return; }
          status.textContent = answer.plan.rows.length ? `${label('count')}: ${answer.plan.rows.length}` : label('scopeEmpty');
          for (const row of answer.plan.rows) {
            const item = node('li', row.path, listing);
            if (row.canBrowseChildren) {
              const more = button(label('scopeBrowse'), () => { kind.value = 'children'; path.value = row.path; switchKind(); readScope(); }, item, true);
              more.setAttribute('aria-label', `${label('scopeBrowse')}: ${row.path}`);
            }
          }
        } catch (error) { if (!controller.signal.aborted) status.textContent = label('failed'); }
        finally { action.disabled = run.disabled = false; close.textContent = label('close'); }
      }
      form.addEventListener('submit', event => { event.preventDefault(); readScope(); });
    }
    const action = button(label('start'), async () => {
      action.disabled = true; output.textContent = label('working'); close.textContent = label('stop');
      try {
        const result = await Api.post(`/api/accounts/${encodeURIComponent(accountId)}/${mode === 'test' ? 'test' : 'sync-plan'}`, {}, { signal: controller.signal });
        if (!result || controller.signal.aborted) return;
        output.replaceChildren();
        for (const name of ['source', 'target']) {
          const side = result[name];
          const detail = side?.ok ? `${label('passed')} · ${label('count')}: ${side.folders}`
            : side?.reason ? reason(side.reason) : label('notChecked');
          node('p', `${label(name)}: ${detail}`, output);
        }
        if (!result.ok && result.category && !result.source?.reason && !result.target?.reason) node('p', reason(result.category), output);
        if (!result.plan) {
          if (mode === 'plan' && canScope(result)) offerSourceScope();
          return;
        }
        const plan = result.plan;
        if (plan.status !== 'estimate') { node('p', label('legacy'), output); return; }
        node('p', label('estimate'), output);
        if (plan.mirrorMessages) node('p', label(plan.truncated ? 'mirrorAll' : 'mirror'), output);
        if (plan.rootMayBeCreated) node('p', label('root'), output);
        const table = node('table', null, output);
        const heading = node('tr', null, node('thead', null, table));
        for (const key of ['from','to','action']) node('th', label(key), heading).scope = 'col';
        const body = node('tbody', null, table);
        const paginationStatus = node('p', '', output); paginationStatus.setAttribute('role', 'status');
        const bookmarks = [plan.pageCursor];
        let index = 0, currentPage = plan, stale = false, submit, previous, next;
        function drawPage() {
          body.replaceChildren();
          for (const row of currentPage.rows) {
            const tr = node('tr', null, body);
            node('td', row.source, tr); node('td', row.destination || '—', tr);
            const details = [label(row.action)];
            if (row.subscribe === 'possible') details.push(label('subscribe'));
            if (row.mayDeleteMessages) details.push(label('deleteMessages'));
            node('td', details.join(' · '), tr);
          }
          if (plan.nextCursor) paginationStatus.textContent = `${currentPage.offset + 1}–${currentPage.offset + currentPage.rows.length} / ${currentPage.totalRows}`;
        }
        function pageButtons(pending) {
          if (previous) previous.disabled = pending || stale || index === 0;
          if (next) next.disabled = pending || stale || !currentPage.nextCursor;
          if (stale && submit) submit.disabled = true;
        }
        async function movePage(position, cursor) {
          pageButtons(true);
          try {
            if (Date.now() >= Date.parse(plan.expiresAt)) { stale = true; paginationStatus.textContent = label('expired'); return; }
            const response = await Api.post(`/api/accounts/${encodeURIComponent(accountId)}/sync-plan/page`,
              { cursor }, { signal: controller.signal });
            if (!response || controller.signal.aborted || !output.contains(body)) return;
            if (!response.ok) {
              stale = response.category === 'config_changed';
              paginationStatus.textContent = stale ? label('expired') : reason(response.category);
              return;
            }
            bookmarks[position] = cursor;
            index = position;
            currentPage = response;
            drawPage();
          } catch (error) { if (!controller.signal.aborted) paginationStatus.textContent = label('failed'); }
          finally { pageButtons(false); }
        }
        if (plan.nextCursor) {
          const navigation = node('p', null, output);
          previous = button(label('previous'), () => movePage(index - 1, bookmarks[index - 1]), navigation, true);
          next = button(label('next'), () => movePage(index + 1, currentPage.nextCursor), navigation, true);
          pageButtons(false);
        }
        drawPage();
        if (plan.ticket && !plan.counts.conflict) {
          submit = button(label('queue'), async () => {
            if (Date.now() >= Date.parse(plan.expiresAt)) { queueStatus.textContent = label('expired'); submit.disabled = true; return; }
            if (!confirm(label('confirm')) || (confirmUnknown && !confirm(syncUi('review')))) return;
            submit.disabled = true;
            try {
              await Api.post(`/api/accounts/${encodeURIComponent(accountId)}/sync`, { planTicket: plan.ticket, confirmUnknown }, { signal: controller.signal });
              toast(label('queued')); dialog.close(); onQueued?.();
            } catch (error) {
              if (!controller.signal.aborted) {
                stale = stale || error.details?.code === 'stale_sync_plan';
                queueStatus.textContent = stale ? label('expired') : error.message;
                pageButtons(false);
              }
            } finally { submit.disabled = stale; }
          }, node('p', null, output));
          const queueStatus = node('p', '', output); queueStatus.setAttribute('role', 'status');
        }
      } catch (error) { if (!controller.signal.aborted) output.textContent = label('failed'); }
      finally { action.disabled = false; close.textContent = label('close'); }
    }, buttons);
    const close = button(label('close'), () => dialog.close(), buttons, true);
    document.body.append(dialog); dialog.showModal();
  }

  return { open, label };
})();
