import { useState, useEffect, useCallback } from "react";

const DEFAULT_SETTINGS = {
  managers: [
    { key: "Боровая", userId: 41, name: "Ия Боровая", active: true }
  ],
  schedule: {
    days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    time: "19:00"
  },
  collection: {
    deals: true,
    calls: true,
    callsLimit: 50,
    aiReport: true,
    period: 0 // 0 = all time
  },
  grokModel: "grok-3-mini"
};

const DAYS_MAP = {
  mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб", sun: "Вс"
};

const PERIOD_OPTIONS = [
  { value: 0, label: "Всё время" },
  { value: 7, label: "7 дней" },
  { value: 14, label: "14 дней" },
  { value: 30, label: "30 дней" },
  { value: 60, label: "60 дней" },
  { value: 90, label: "90 дней" }
];

export default function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activeTab, setActiveTab] = useState("schedule");
  const [saved, setSaved] = useState(false);
  const [newManager, setNewManager] = useState({ key: "", userId: "", name: "" });
  const [showAdd, setShowAdd] = useState(false);
  const [generatedScript, setGeneratedScript] = useState("");
  const [showScript, setShowScript] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("transcom-settings");
        if (res?.value) setSettings(JSON.parse(res.value));
      } catch {}
    })();
  }, []);

  const saveSettings = useCallback(async (s) => {
    setSettings(s);
    try {
      await window.storage.set("transcom-settings", JSON.stringify(s));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
  }, []);

  const updateSchedule = (field, value) => {
    const next = { ...settings, schedule: { ...settings.schedule, [field]: value } };
    saveSettings(next);
  };

  const toggleDay = (day) => {
    const next = {
      ...settings,
      schedule: {
        ...settings.schedule,
        days: { ...settings.schedule.days, [day]: !settings.schedule.days[day] }
      }
    };
    saveSettings(next);
  };

  const updateCollection = (field, value) => {
    const next = { ...settings, collection: { ...settings.collection, [field]: value } };
    saveSettings(next);
  };

  const toggleManager = (idx) => {
    const mgrs = [...settings.managers];
    mgrs[idx] = { ...mgrs[idx], active: !mgrs[idx].active };
    saveSettings({ ...settings, managers: mgrs });
  };

  const removeManager = (idx) => {
    const mgrs = settings.managers.filter((_, i) => i !== idx);
    saveSettings({ ...settings, managers: mgrs });
  };

  const addManager = () => {
    if (!newManager.key || !newManager.userId || !newManager.name) return;
    const mgrs = [...settings.managers, { ...newManager, userId: parseInt(newManager.userId), active: true }];
    saveSettings({ ...settings, managers: mgrs });
    setNewManager({ key: "", userId: "", name: "" });
    setShowAdd(false);
  };

  const generateBat = () => {
    const activeMgrs = settings.managers.filter(m => m.active);
    const days = settings.schedule.days;
    const time = settings.schedule.time;
    const period = settings.collection.period;

    // Generate MANAGERS block for analytics.js
    const managersBlock = settings.managers
      .map(m => `  '${m.key}': { userId: ${m.userId}, name: '${m.name}' },`)
      .join("\n");

    // Generate batch commands
    const cmds = activeMgrs.map(m => {
      const args = period > 0 ? `"${m.key}" ${period}` : `"${m.key}"`;
      return `node C:\\transcom\\analytics.js ${args}`;
    }).join("\n");

    // Windows Task Scheduler days
    const dayNames = { mon: "MON", tue: "TUE", wed: "WED", thu: "THU", fri: "FRI", sat: "SAT", sun: "SUN" };
    const activeDays = Object.entries(days).filter(([, v]) => v).map(([k]) => dayNames[k]).join(",");

    const script = `:: ====== run_analytics.bat ======
:: Положить в C:\\transcom\\run_analytics.bat
@echo off
cd /d C:\\transcom
echo [%date% %time%] Запуск аналитики...

${cmds}

echo [%date% %time%] Готово!

:: ====== MANAGERS в analytics.js ======
:: Замени блок MANAGERS в analytics.js на:
::
:: const MANAGERS = {
${managersBlock.split("\n").map(l => ":: " + l).join("\n")}
:: };

:: ====== Настройка автозапуска ======
:: Выполни в CMD от администратора:
::
:: schtasks /create /tn "TranscomAnalytics" /tr "C:\\transcom\\run_analytics.bat" /sc weekly /d ${activeDays} /st ${time} /f
::
:: Удалить задание: schtasks /delete /tn "TranscomAnalytics" /f`;

    setGeneratedScript(script);
    setShowScript(true);
  };

  const tabs = [
    { id: "schedule", label: "Расписание", icon: "📅" },
    { id: "collect", label: "Сбор данных", icon: "📊" },
    { id: "managers", label: "Менеджеры", icon: "👥" },
    { id: "export", label: "Экспорт", icon: "⚙️" }
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(145deg, #0a0e1a 0%, #111827 50%, #0f172a 100%)",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      color: "#e2e8f0",
      padding: "0"
    }}>
      {/* Header */}
      <div style={{
        background: "rgba(15, 23, 42, 0.8)",
        borderBottom: "1px solid rgba(59, 130, 246, 0.15)",
        padding: "20px 24px",
        backdropFilter: "blur(20px)"
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, fontWeight: 700, color: "#fff"
            }}>T</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
                ТрансКом Аналитика
              </div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 1 }}>Настройки сбора данных</div>
            </div>
            {saved && (
              <div style={{
                marginLeft: "auto", fontSize: 13, color: "#34d399",
                background: "rgba(52, 211, 153, 0.1)", padding: "5px 12px",
                borderRadius: 6, border: "1px solid rgba(52, 211, 153, 0.2)"
              }}>✓ Сохранено</div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        background: "rgba(15, 23, 42, 0.5)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        padding: "0 24px"
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", gap: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              padding: "14px 20px", border: "none", cursor: "pointer",
              background: activeTab === t.id ? "rgba(59, 130, 246, 0.1)" : "transparent",
              color: activeTab === t.id ? "#60a5fa" : "#64748b",
              fontSize: 14, fontWeight: 500, fontFamily: "inherit",
              borderBottom: activeTab === t.id ? "2px solid #3b82f6" : "2px solid transparent",
              transition: "all 0.2s"
            }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 80px" }}>

        {/* === SCHEDULE TAB === */}
        {activeTab === "schedule" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Card title="Дни запуска" subtitle="Когда собирать данные">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.entries(DAYS_MAP).map(([key, label]) => (
                  <button key={key} onClick={() => toggleDay(key)} style={{
                    width: 52, height: 52, borderRadius: 12, border: "none", cursor: "pointer",
                    background: settings.schedule.days[key]
                      ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "rgba(30, 41, 59, 0.8)",
                    color: settings.schedule.days[key] ? "#fff" : "#64748b",
                    fontSize: 15, fontWeight: 600, fontFamily: "inherit",
                    transition: "all 0.2s",
                    boxShadow: settings.schedule.days[key] ? "0 4px 15px rgba(59, 130, 246, 0.3)" : "none"
                  }}>
                    {label}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="Время запуска" subtitle="Во сколько стартует сбор">
              <input
                type="time" value={settings.schedule.time}
                onChange={e => updateSchedule("time", e.target.value)}
                style={{
                  background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10, padding: "12px 16px", color: "#e2e8f0",
                  fontSize: 20, fontFamily: "inherit", fontWeight: 600,
                  outline: "none", width: 140
                }}
              />
              <div style={{ marginTop: 8, fontSize: 13, color: "#64748b" }}>
                Рекомендуем 19:00 — после рабочего дня
              </div>
            </Card>

            <InfoBox>
              Расписание: {Object.entries(settings.schedule.days)
                .filter(([, v]) => v).map(([k]) => DAYS_MAP[k]).join(", ") || "не выбрано"
              } в {settings.schedule.time}
            </InfoBox>
          </div>
        )}

        {/* === COLLECTION TAB === */}
        {activeTab === "collect" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Card title="Что собирать" subtitle="Настрой блоки отчёта">
              <ToggleRow
                label="📋 Сделки и воронка"
                desc="Загрузка всех сделок менеджера из Планфикса"
                checked={settings.collection.deals}
                onChange={() => updateCollection("deals", !settings.collection.deals)}
              />
              <Divider />
              <ToggleRow
                label="📞 Звонки и активность"
                desc="Анализ комментариев: исходящие, входящие, НДЗ"
                checked={settings.collection.calls}
                onChange={() => updateCollection("calls", !settings.collection.calls)}
              />
              {settings.collection.calls && (
                <div style={{ marginLeft: 48, marginTop: 12 }}>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>
                    Сколько сделок анализировать на звонки:
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[20, 50, 100].map(n => (
                      <button key={n} onClick={() => updateCollection("callsLimit", n)} style={{
                        padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer",
                        background: settings.collection.callsLimit === n
                          ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "rgba(30, 41, 59, 0.8)",
                        color: settings.collection.callsLimit === n ? "#fff" : "#94a3b8",
                        fontSize: 14, fontWeight: 600, fontFamily: "inherit"
                      }}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
              <Divider />
              <ToggleRow
                label="🤖 ИИ-отчёт (Grok)"
                desc="Рекомендации от ИИ на основе данных"
                checked={settings.collection.aiReport}
                onChange={() => updateCollection("aiReport", !settings.collection.aiReport)}
              />
            </Card>

            <Card title="Период данных" subtitle="За какое время собирать сделки">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {PERIOD_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => updateCollection("period", opt.value)} style={{
                    padding: "10px 20px", borderRadius: 10, border: "none", cursor: "pointer",
                    background: settings.collection.period === opt.value
                      ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "rgba(30, 41, 59, 0.8)",
                    color: settings.collection.period === opt.value ? "#fff" : "#94a3b8",
                    fontSize: 14, fontWeight: 500, fontFamily: "inherit",
                    transition: "all 0.2s",
                    boxShadow: settings.collection.period === opt.value ? "0 4px 15px rgba(59, 130, 246, 0.3)" : "none"
                  }}>{opt.label}</button>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* === MANAGERS TAB === */}
        {activeTab === "managers" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Card title="Менеджеры" subtitle="Кого отслеживать">
              {settings.managers.map((m, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 0",
                  borderBottom: i < settings.managers.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none"
                }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: m.active ? "linear-gradient(135deg, #3b82f6, #8b5cf6)" : "rgba(30, 41, 59, 0.8)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 16, color: m.active ? "#fff" : "#64748b",
                    fontWeight: 700, flexShrink: 0
                  }}>{m.name.charAt(0)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: m.active ? "#f1f5f9" : "#64748b" }}>
                      {m.name}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      user:{m.userId} · ключ: {m.key}
                    </div>
                  </div>
                  <Toggle checked={m.active} onChange={() => toggleManager(i)} />
                  <button onClick={() => removeManager(i)} style={{
                    background: "none", border: "none", color: "#64748b",
                    cursor: "pointer", fontSize: 18, padding: 4
                  }}>×</button>
                </div>
              ))}

              {showAdd ? (
                <div style={{
                  marginTop: 16, padding: 16,
                  background: "rgba(30, 41, 59, 0.5)", borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.08)"
                }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <InputField label="Фамилия (ключ)" value={newManager.key}
                      onChange={e => setNewManager({ ...newManager, key: e.target.value })}
                      placeholder="Иванов" />
                    <InputField label="Полное имя" value={newManager.name}
                      onChange={e => setNewManager({ ...newManager, name: e.target.value })}
                      placeholder="Иван Иванов" />
                    <InputField label="User ID в Планфиксе" value={newManager.userId}
                      onChange={e => setNewManager({ ...newManager, userId: e.target.value })}
                      placeholder="42" />
                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <button onClick={addManager} style={{
                        padding: "10px 24px", borderRadius: 8, border: "none", cursor: "pointer",
                        background: "linear-gradient(135deg, #3b82f6, #6366f1)",
                        color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "inherit"
                      }}>Добавить</button>
                      <button onClick={() => setShowAdd(false)} style={{
                        padding: "10px 24px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)",
                        background: "transparent", color: "#94a3b8", fontSize: 14,
                        cursor: "pointer", fontFamily: "inherit"
                      }}>Отмена</button>
                    </div>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowAdd(true)} style={{
                  marginTop: 12, padding: "10px 20px", borderRadius: 10,
                  border: "1px dashed rgba(59, 130, 246, 0.3)",
                  background: "rgba(59, 130, 246, 0.05)",
                  color: "#60a5fa", fontSize: 14, cursor: "pointer",
                  fontFamily: "inherit", width: "100%"
                }}>+ Добавить менеджера</button>
              )}
            </Card>

            <InfoBox>
              💡 User ID менеджера можно найти в Планфиксе: Настройки → Сотрудники → откройте карточку → ID в URL
            </InfoBox>
          </div>
        )}

        {/* === EXPORT TAB === */}
        {activeTab === "export" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Card title="Сгенерировать скрипт" subtitle="Готовый .bat файл и команда для автозапуска">
              <button onClick={generateBat} style={{
                padding: "14px 28px", borderRadius: 10, border: "none", cursor: "pointer",
                background: "linear-gradient(135deg, #3b82f6, #6366f1)",
                color: "#fff", fontSize: 15, fontWeight: 600, fontFamily: "inherit",
                width: "100%", boxShadow: "0 4px 20px rgba(59, 130, 246, 0.3)"
              }}>
                ⚡ Сгенерировать run_analytics.bat
              </button>

              {showScript && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 13, color: "#94a3b8" }}>Скопируй и сохрани как C:\transcom\run_analytics.bat</span>
                    <button onClick={() => {
                      navigator.clipboard?.writeText(generatedScript);
                    }} style={{
                      padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.1)",
                      background: "rgba(30, 41, 59, 0.8)", color: "#60a5fa",
                      fontSize: 12, cursor: "pointer", fontFamily: "inherit"
                    }}>📋 Копировать</button>
                  </div>
                  <pre style={{
                    background: "rgba(0, 0, 0, 0.4)", borderRadius: 10,
                    padding: 16, fontSize: 12, lineHeight: 1.6,
                    color: "#a5f3fc", overflow: "auto", maxHeight: 400,
                    border: "1px solid rgba(255,255,255,0.05)",
                    whiteSpace: "pre-wrap", wordBreak: "break-all"
                  }}>{generatedScript}</pre>
                </div>
              )}
            </Card>

            <Card title="Быстрый запуск" subtitle="Команды для ручного запуска">
              {settings.managers.filter(m => m.active).map(m => {
                const period = settings.collection.period;
                const cmd = period > 0
                  ? `node C:\\transcom\\analytics.js "${m.key}" ${period}`
                  : `node C:\\transcom\\analytics.js "${m.key}"`;
                return (
                  <div key={m.key} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", marginBottom: 8,
                    background: "rgba(0, 0, 0, 0.3)", borderRadius: 8,
                    fontFamily: "monospace", fontSize: 13, color: "#a5f3fc"
                  }}>
                    <span style={{ color: "#64748b" }}>$</span>
                    <span style={{ flex: 1 }}>{cmd}</span>
                    <button onClick={() => navigator.clipboard?.writeText(cmd)} style={{
                      background: "none", border: "none", color: "#64748b",
                      cursor: "pointer", fontSize: 14
                    }}>📋</button>
                  </div>
                );
              })}
            </Card>

            <Card title="Текущая конфигурация" subtitle="Сводка всех настроек">
              <div style={{ fontSize: 13, lineHeight: 2, color: "#94a3b8" }}>
                <div><span style={{ color: "#64748b" }}>Расписание:</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>
                    {Object.entries(settings.schedule.days).filter(([,v]) => v).map(([k]) => DAYS_MAP[k]).join(", ")} в {settings.schedule.time}
                  </span>
                </div>
                <div><span style={{ color: "#64748b" }}>Период:</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>
                    {PERIOD_OPTIONS.find(o => o.value === settings.collection.period)?.label}
                  </span>
                </div>
                <div><span style={{ color: "#64748b" }}>Звонки:</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>
                    {settings.collection.calls ? `да, топ-${settings.collection.callsLimit} сделок` : "выкл"}
                  </span>
                </div>
                <div><span style={{ color: "#64748b" }}>ИИ-отчёт:</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>
                    {settings.collection.aiReport ? `да (${settings.grokModel})` : "выкл"}
                  </span>
                </div>
                <div><span style={{ color: "#64748b" }}>Менеджеры:</span>{" "}
                  <span style={{ color: "#e2e8f0" }}>
                    {settings.managers.filter(m => m.active).map(m => m.name).join(", ") || "нет"}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== UI Components =====

function Card({ title, subtitle, children }) {
  return (
    <div style={{
      background: "rgba(15, 23, 42, 0.6)", borderRadius: 16,
      border: "1px solid rgba(255,255,255,0.06)",
      padding: "20px 22px", backdropFilter: "blur(10px)"
    }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <div onClick={onChange} style={{
      width: 44, height: 24, borderRadius: 12, cursor: "pointer",
      background: checked ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "rgba(30, 41, 59, 0.8)",
      border: "1px solid " + (checked ? "transparent" : "rgba(255,255,255,0.1)"),
      position: "relative", transition: "all 0.3s", flexShrink: 0
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: 9, background: "#fff",
        position: "absolute", top: 2, left: checked ? 22 : 3,
        transition: "left 0.3s", boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
      }} />
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
      <div style={{ paddingTop: 2 }}><Toggle checked={checked} onChange={onChange} /></div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: checked ? "#f1f5f9" : "#64748b" }}>{label}</div>
        <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{desc}</div>
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", margin: "12px 0" }} />;
}

function InfoBox({ children }) {
  return (
    <div style={{
      background: "rgba(59, 130, 246, 0.06)", borderRadius: 12,
      border: "1px solid rgba(59, 130, 246, 0.12)",
      padding: "14px 18px", fontSize: 14, color: "#94a3b8", lineHeight: 1.6
    }}>{children}</div>
  );
}

function InputField({ label, value, onChange, placeholder }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>{label}</div>
      <input value={value} onChange={onChange} placeholder={placeholder} style={{
        width: "100%", background: "rgba(15, 23, 42, 0.8)",
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
        padding: "10px 12px", color: "#e2e8f0", fontSize: 14,
        fontFamily: "inherit", outline: "none", boxSizing: "border-box"
      }} />
    </div>
  );
}
