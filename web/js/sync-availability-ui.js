'use strict';

// Account and task views share these labels. Stable API codes stay untranslated.
const syncUi = (() => {
  const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE'];
  const text = {
    checking: ['连接检查', 'Testing connection'],
    preparing: ['准备传输', 'Preparing transfer'],
    transfer: ['邮件传输', 'Transferring mail'],
    cancelling: ['正在停止', 'Stopping'],
    manual: ['手动', 'Manual'], scheduled: ['定时', 'Scheduled'], bulk: ['批量', 'Bulk'], retry: ['重试', 'Retry'],
    targetFolders: ['目标文件夹数', 'Target folders'],
    paused: ['暂停', 'Paused', '一時停止', '일시 중지', 'Pausado', 'En pause', 'Pausiert'],
    deferred: ['延后', 'Deferred', '延期', '연기', 'Aplazado', 'Différé', 'Verschoben'],
    lastAttempt: ['最近尝试', 'Last attempt', '前回の試行', '최근 시도', 'Último intento', 'Dernière tentative', 'Letzter Versuch'],
    lastSuccess: ['最近成功', 'Last success', '前回の成功', '최근 성공', 'Último éxito', 'Dernière réussite', 'Letzter Erfolg'],
    nextScheduled: ['计划时间', 'Scheduled for', '予定時刻', '예정 시간', 'Hora prevista', 'Heure prévue', 'Geplant für'],
    nextRetry: ['下次检查', 'Next check', '次の確認', '다음 확인', 'Próxima comprobación', 'Prochaine vérification', 'Nächste Prüfung'],
    unknownTime: ['尚无记录', 'No record yet', '記録なし', '기록 없음', 'Sin registro', 'Aucun résultat enregistré', 'Noch kein Eintrag'],
    blocked: ['暂不能同步', 'Sync is blocked', '同期できません', '동기화 대기', 'Sincronización bloqueada', 'Synchronisation bloquée', 'Synchronisierung blockiert'],
    unknown: ['结果待核对', 'Result needs review', '結果を要確認', '결과 확인 필요', 'Resultado por revisar', 'Résultat à vérifier', 'Ergebnis prüfen'],
    pause: ['暂停定时同步', 'Pause scheduled sync', '定期同期を一時停止', '예약 동기화 일시 중지', 'Pausar sincronización programada', 'Suspendre la synchronisation planifiée', 'Geplante Synchronisierung pausieren'],
    resume: ['恢复定时同步', 'Resume scheduled sync', '定期同期を再開', '예약 동기화 재개', 'Reanudar sincronización programada', 'Reprendre la synchronisation planifiée', 'Geplante Synchronisierung fortsetzen'],
    pauseUntil: ['暂停至（本地时间）', 'Pause until (local time)', '停止終了時刻（現地時間）', '중지 종료 (현지 시간)', 'Pausar hasta (hora local)', 'Suspendre jusqu’à (heure locale)', 'Pausieren bis (Ortszeit)'],
    pauseHint: ['进行中的任务会继续。此设置不影响手动同步。', 'Work already in progress continues. Manual sync remains available.', '実行中の処理は続行します。手動同期は利用できます。', '진행 중인 작업은 계속됩니다. 수동 동기화는 사용할 수 있습니다.', 'El trabajo en curso continúa. La sincronización manual sigue disponible.', 'Les tâches en cours continuent. La synchronisation manuelle reste disponible.', 'Laufende Aufgaben werden fortgesetzt. Manuelle Synchronisierung bleibt verfügbar.'],
    badPause: ['请选择未来 30 天内的暂停结束时间。', 'Choose an end time within the next 30 days.', '30 日以内の終了時刻を指定してください。', '앞으로 30일 이내의 종료 시간을 선택하세요.', 'Elige una hora de fin dentro de los próximos 30 días.', 'Choisissez une heure de fin dans les 30 prochains jours.', 'Wählen Sie eine Endzeit innerhalb der nächsten 30 Tage.'],
    account_paused: ['已暂停定时同步', 'Scheduled sync is paused', '定期同期を停止中', '예약 동기화가 일시 중지됨', 'Sincronización programada en pausa', 'Synchronisation planifiée suspendue', 'Geplante Synchronisierung pausiert'],
    low_space: ['存储空间不足，请释放空间', 'Free up storage space', '空き容量を確保してください', '저장 공간을 확보하세요', 'Libera espacio de almacenamiento', 'Libérez de l’espace de stockage', 'Speicherplatz freigeben'],
    low_inodes: ['可用文件节点不足，请清理小文件或检查挂载', 'Too few free inodes; remove unnecessary files or check the mount', '空き inode が不足しています。不要なファイルまたはマウントを確認してください', '여유 inode가 부족합니다. 불필요한 파일이나 마운트를 확인하세요', 'Faltan inodos; elimina archivos innecesarios o comprueba el montaje', 'Inodes insuffisants : nettoyez les fichiers ou vérifiez le montage', 'Zu wenige freie Inodes; Dateien bereinigen oder Einhängung prüfen'],
    capacity_unavailable: ['无法确认存储容量，请检查挂载', 'Cannot confirm available storage; check the mount', '空き容量を確認できません。マウントを確認してください', '저장 공간을 확인할 수 없습니다. 마운트를 확인하세요', 'No se pudo confirmar el espacio disponible; comprueba el montaje', 'Impossible de vérifier le stockage disponible : vérifiez le montage', 'Freier Speicher nicht ermittelbar; Einhängung prüfen'],
    capacity_busy: ['正在等待容量检查', 'Waiting for a storage check', '空き容量の確認待ち', '저장 공간 확인 대기 중', 'Pendiente de comprobar el almacenamiento', 'En attente de la vérification du stockage', 'Warten auf die Speicherprüfung'],
    credential_missing: ['请配置账号凭据', 'Configure account credentials', 'アカウントの認証情報を設定してください', '계정 자격 증명을 설정하세요', 'Configura las credenciales de la cuenta', 'Configurez les identifiants du compte', 'Kontozugangsdaten einrichten'],
    authorization_required: ['请重新授权邮箱', 'Reauthorize this mailbox', 'メールボックスを再認証してください', '이 메일함을 다시 인증하세요', 'Vuelve a autorizar el buzón', 'Autorisez à nouveau cette boîte mail', 'Postfach erneut autorisieren'],
    queue_degraded: ['队列待核对，请查看系统状态', 'Queue needs review; check system status', 'キューを要確認。システム状態を確認してください', '대기열 확인 필요. 시스템 상태를 확인하세요', 'Revisa la cola en el estado del sistema', 'File à vérifier : consultez l’état du système', 'Warteschlange prüfen; Systemstatus ansehen'],
    maintenance: ['系统正在维护', 'System maintenance in progress', 'システムのメンテナンス中', '시스템 점검 중', 'Mantenimiento del sistema en curso', 'Maintenance du système en cours', 'Systemwartung läuft'],
    provider_busy: ['同服务商任务正在运行', 'Waiting for another task using the same provider', '同じプロバイダーの処理待ち', '같은 서비스 제공자의 작업 대기 중', 'A la espera de otra tarea del proveedor', 'En attente d’une autre tâche du même fournisseur', 'Warten auf eine Aufgabe beim selben Anbieter'],
    provider_cooldown: ['邮箱服务商暂时限流', 'The mail provider is temporarily limiting requests', 'メール提供元が一時的に制限中', '메일 제공자가 요청을 일시적으로 제한 중', 'El proveedor limita temporalmente las solicitudes', 'Le fournisseur limite temporairement les requêtes', 'Der Mailanbieter begrenzt Anfragen vorübergehend'],
    providerLimit: ['每个邮箱服务商的默认并发上限', 'Default limit per mail provider', 'メール提供元ごとの既定の同時処理数', '메일 제공자별 기본 동시 작업 한도', 'Límite predeterminado por proveedor', 'Limite par défaut par fournisseur', 'Standardlimit pro Mailanbieter'],
    providerLimits: ['单独设置服务商上限', 'Set limits for individual providers', '提供元ごとの上限を設定', '제공자별 한도 설정', 'Definir límites por proveedor', 'Définir des limites par fournisseur', 'Limits für einzelne Anbieter einstellen'],
    providerDefault: ['使用默认上限', 'Use default limit', '既定の上限を使用', '기본 한도 사용', 'Usar el límite predeterminado', 'Utiliser la limite par défaut', 'Standardlimit verwenden'],
    providerLimitHint: ['自定义 IMAP 按服务器地址、端口和加密方式分组，使用默认上限。所有任务仍受总并发数限制。', 'Custom IMAP uses the default limit per host, port and encryption mode. The overall limit still applies to all jobs.', 'カスタム IMAP にはホスト、ポート、暗号化方式ごとに既定の上限が適用されます。すべての処理に全体の上限も適用されます。', '사용자 지정 IMAP은 호스트, 포트, 암호화 방식마다 기본 한도를 사용합니다. 전체 한도는 모든 작업에 적용됩니다.', 'El límite predeterminado de IMAP personalizado se aplica por servidor, puerto y cifrado. El límite global sigue vigente.', 'Pour IMAP personnalisé, la limite par défaut s’applique par serveur, port et chiffrement. La limite globale reste applicable.', 'Für benutzerdefiniertes IMAP gilt das Standardlimit je Host, Port und Verschlüsselung. Das Gesamtlimit gilt weiterhin.'],
    review: ['上次同步结果未确认，可能已改动邮件。确认检查过邮箱后重新同步？', 'The previous sync could have changed mail. Check your mailbox before confirming another sync.', '前回の同期でメールが変更された可能性があります。メールを確認してから同期を再実行しますか？', '지난 동기화가 메일을 변경했을 수 있습니다. 메일함을 확인한 뒤 다시 동기화할까요?', 'La sincronización anterior pudo cambiar mensajes. Comprueba el buzón antes de confirmar otra sincronización.', 'La dernière synchronisation a pu modifier des messages. Vérifiez la boîte avant de confirmer une nouvelle synchronisation.', 'Die letzte Synchronisierung könnte E-Mails geändert haben. Prüfen Sie das Postfach vor dem erneuten Start.'],
    confirm_unknown_result: ['请先核对上次同步结果', 'Check the previous sync result first', '前回の同期結果を確認してください', '지난 동기화 결과를 먼저 확인하세요', 'Comprueba primero el resultado anterior', 'Vérifiez d’abord le résultat précédent', 'Zuerst das letzte Ergebnis prüfen'],
  };
  return key => {
    const row = text[key];
    const locale = window.I18n?.locale || document.documentElement.lang;
    return row ? row[locales.indexOf(locale)] || row[0] : key;
  };
})();
