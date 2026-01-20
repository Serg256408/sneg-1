
import React, { useState, useMemo } from 'react';
import { Order, OrderStatus, AssetType, AssetRequirement, OrderRestrictions, CustomerContact } from '../types';

interface CustomerPortalProps {
  orders: Order[];
  onAddOrder: (order: Partial<Order>) => void;
  onUpdateOrder: (orderId: string, updates: Partial<Order>) => void;
}

const CustomerPortal: React.FC<CustomerPortalProps> = ({ orders, onAddOrder, onUpdateOrder }) => {
  const [view, setView] = useState<'form' | 'history' | 'active' | 'referral'>('active');
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [isProcessingDoc, setIsProcessingDoc] = useState<string | null>(null);
  
  const [customerPhone, setCustomerPhone] = useState(() => localStorage.getItem('snow_customer_phone') || '');

  const myOrders = useMemo(() => {
    if (!customerPhone) return [];
    return orders.filter(o => o.contactInfo?.phone === customerPhone);
  }, [orders, customerPhone]);

  const activeOrders = useMemo(() => {
    return myOrders.filter(o => 
      o.status !== OrderStatus.COMPLETED && 
      o.status !== OrderStatus.CANCELLED &&
      o.status !== OrderStatus.DOCUMENTS_READY
    );
  }, [myOrders]);

  const completedOrders = useMemo(() => {
    return myOrders.filter(o => o.status === OrderStatus.COMPLETED || o.status === OrderStatus.DOCUMENTS_READY);
  }, [myOrders]);

  // Функция для расчета итогов по заказу (суммирование всех ресурсов)
  const calculateOrderTotals = (order: Order) => {
    let totalTruckCost = 0;
    let totalLoaderCost = 0;
    let totalTrips = order.actualTrips || 0;

    order.assetRequirements.forEach(req => {
      if (req.type === AssetType.TRUCK) {
        // Стоимость рейсов = Общее кол-во рейсов на объекте * цена заказчика
        // (Предполагаем, что цена для заказчика на один тип техники на объекте одинакова)
        totalTruckCost = totalTrips * (req.customerPrice || 0);
      } else {
        // Для погрузчиков считаем по сменам (кол-во утвержденных единиц)
        const approvedUnits = (order.driverDetails || []).filter(d => d.assetType === req.type && d.tripsConfirmed).length;
        // Если объект в работе, но еще не утвержден, показываем плановую стоимость для ориентира
        const unitsToCount = approvedUnits > 0 ? approvedUnits : (order.driverDetails || []).filter(d => d.assetType === req.type).length;
        totalLoaderCost += unitsToCount * (req.customerPrice || 0);
      }
    });

    return {
      totalTrips,
      totalTruckCost,
      totalLoaderCost,
      grandTotal: totalTruckCost + totalLoaderCost
    };
  };

  const [formData, setFormData] = useState<Partial<Order>>({
    customer: '',
    address: '',
    plannedTrips: 5,
    actualTrips: 0,
    scheduledTime: new Date(Date.now() + 3600000).toISOString().slice(0, 16),
    restrictions: {
      hasHeightLimit: false,
      hasNarrowEntrance: false,
      hasPermitRegime: false,
      isNightWorkProhibited: false,
      comment: ''
    },
    contactInfo: {
      name: '',
      phone: customerPhone,
      email: '',
      inn: '',
      companyName: ''
    },
    assetRequirements: [{ type: AssetType.TRUCK, contractorId: '', contractorName: 'Биржа', plannedUnits: 1, customerPrice: 0, birzhaPrice: 0 }]
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.contactInfo?.phone) {
      localStorage.setItem('snow_customer_phone', formData.contactInfo.phone);
      setCustomerPhone(formData.contactInfo.phone);
    }
    const resolvedCustomer = formData.customer || formData.contactInfo?.companyName || formData.contactInfo?.name || '';
    onAddOrder({ ...formData, customer: resolvedCustomer });
    setView('active');
  };

  const handleDownloadDoc = (type: string) => {
    setIsProcessingDoc(type);
    setTimeout(() => {
      setIsProcessingDoc(null);
      setShareStatus(`Документ "${type}" успешно сформирован и загружен.`);
      setTimeout(() => setShareStatus(null), 3000);
    }, 1500);
  };

  const handleSendToSocial = (channel: 'telegram' | 'email') => {
    const message = channel === 'telegram' ? 'Комплект документов отправлен в ваш Telegram бот.' : 'Документы отправлены на вашу почту.';
    setShareStatus(message);
    setTimeout(() => setShareStatus(null), 4000);
  };

  const handleConfirmOrder = (orderId: string, urgent: boolean = false) => {
    onUpdateOrder(orderId, {
      status: OrderStatus.CONFIRMED_BY_CUSTOMER,
      isFrozen: true
    });
    setShareStatus(urgent ? 'Заявка запущена в работу СРОЧНО! Документы сформированы.' : 'Условия подтверждены. Сформирован договор и счет.');
    setTimeout(() => setShareStatus(null), 5000);
  };

  const handleRequestEdits = () => {
     setShareStatus('Запрос на правки отправлен менеджеру. С Вами свяжутся.');
     setTimeout(() => setShareStatus(null), 5000);
  };

  const updateRestriction = (field: keyof OrderRestrictions, value: any) => {
    setFormData(prev => ({
      ...prev,
      restrictions: { ...prev.restrictions!, [field]: value }
    }));
  };

  const updateContact = (field: keyof CustomerContact, value: any) => {
    setFormData(prev => {
      const contactInfo = { ...(prev.contactInfo || {}), [field]: value };
      const shouldUpdateCustomer = field === 'name' || field === 'companyName';
      const customer = shouldUpdateCustomer && value ? value : prev.customer;
      return {
        ...prev,
        contactInfo,
        customer
      };
    });
  };

  const toggleAssetType = (type: AssetType) => {
    setFormData(prev => {
      const requirements = prev.assetRequirements || [];
      const exists = requirements.some(r => r.type === type);
      if (exists) {
        return { ...prev, assetRequirements: requirements.filter(r => r.type !== type) };
      } else {
        return { ...prev, assetRequirements: [...requirements, { type, contractorId: '', contractorName: 'Биржа', plannedUnits: 1 }] };
      }
    });
  };

  const formatDateTime = (isoString: string) => {
    return new Date(isoString).toLocaleString('ru', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case OrderStatus.SENT:
        return <span className="px-4 py-1.5 rounded-xl bg-slate-600/20 text-slate-400 border border-slate-500/20 text-[10px] font-black uppercase tracking-widest">Заявка отправлена</span>;
      case OrderStatus.WAITING_APPROVAL:
        return <span className="px-4 py-1.5 rounded-xl bg-orange-600/20 text-orange-400 border border-orange-500/20 text-[10px] font-black uppercase tracking-widest">На проверке</span>;
      case OrderStatus.AWAITING_CUSTOMER:
        return <span className="px-4 py-1.5 rounded-xl bg-blue-600/20 text-blue-400 border border-white/5 text-[10px] font-black uppercase tracking-widest animate-pulse">Ожидает вашего решения</span>;
      case OrderStatus.CONFIRMED_BY_CUSTOMER:
        return <span className="px-4 py-1.5 rounded-xl bg-green-600/20 text-green-400 border border-green-500/20 text-[10px] font-black uppercase tracking-widest">Условия приняты</span>;
      case OrderStatus.IN_PROGRESS:
        return <span className="px-4 py-1.5 rounded-xl bg-green-600/20 text-green-400 border border-green-500/20 text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></span> В работе</span>;
      case OrderStatus.COMPLETED:
        return <span className="px-4 py-1.5 rounded-xl bg-green-600/20 text-green-500 border border-green-500/40 text-[10px] font-black uppercase tracking-widest">Выполнено</span>;
      default:
        return <span className="px-4 py-1.5 rounded-xl bg-slate-800 text-slate-500 text-[10px] font-black uppercase tracking-widest">{status}</span>;
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0f1d] text-white font-['Inter']">
      {shareStatus && (
        <div className="bg-blue-600 text-white text-[10px] font-black uppercase text-center py-3 fixed top-0 left-0 right-0 z-[100] tracking-widest shadow-2xl animate-in slide-in-from-top duration-300">
          {shareStatus}
        </div>
      )}

      {/* Header */}
      <div className="p-6 bg-[#0a0f1d] border-b border-white/5 flex flex-col md:flex-row justify-between items-center sticky top-0 z-20 gap-4">
        <div className="flex items-center gap-3">
           <span className="text-2xl">❄️</span>
           <h1 className="text-xl font-black uppercase tracking-tight">Личный кабинет заказчика</h1>
        </div>
        <div className="flex bg-[#12192c] p-1 rounded-full border border-white/5 shadow-2xl">
          <button onClick={() => setView('active')} className={`px-6 py-2 text-[10px] font-bold uppercase rounded-full transition-all whitespace-nowrap ${view === 'active' ? 'bg-[#1c2641] text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>Текущая заявка</button>
          <button onClick={() => setView('form')} className={`px-6 py-2 text-[10px] font-bold uppercase rounded-full transition-all whitespace-nowrap ${view === 'form' ? 'bg-[#1c2641] text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>Новый заказ</button>
          <button onClick={() => setView('history')} className={`px-6 py-2 text-[10px] font-bold uppercase rounded-full transition-all whitespace-nowrap ${view === 'history' ? 'bg-[#1c2641] text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>Мои заявки</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-5xl mx-auto w-full pb-32">
        {view === 'active' ? (
           <div className="space-y-8 animate-in fade-in duration-500">
             {activeOrders.length === 0 ? (
               <div className="text-center py-32 bg-[#12192c]/40 rounded-[4rem] border border-white/5 border-dashed">
                 <div className="text-7xl mb-8 opacity-20">🚜</div>
                 <p className="text-sm font-black uppercase tracking-[0.4em] text-slate-500">Нет активных работ</p>
                 <button onClick={() => setView('form')} className="mt-8 bg-blue-600 text-white px-10 py-4 rounded-3xl text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-all shadow-2xl">Создать заявку</button>
               </div>
             ) : (
               activeOrders.map(order => {
                 const isConfirmed = order.status === OrderStatus.CONFIRMED_BY_CUSTOMER || order.status === OrderStatus.IN_PROGRESS || order.status === OrderStatus.COMPLETED;
                 const isTechAssigned = !order.isBirzhaOpen && (order.driverDetails || []).length > 0;
                 const isLoaderOnSite = (order.status === OrderStatus.IN_PROGRESS || order.status === OrderStatus.COMPLETED);
                 const isExporting = (order.actualTrips || 0) > 0;
                 const isFinished = order.status === OrderStatus.COMPLETED;
                 const orderTotals = calculateOrderTotals(order);

                 const steps = [
                   { label: 'Техника назначена', done: isTechAssigned, id: 1 },
                   { label: 'Погрузчик на объекте', done: isLoaderOnSite, active: isTechAssigned && order.status !== OrderStatus.IN_PROGRESS && order.status !== OrderStatus.COMPLETED, id: 2 },
                   { label: 'Идёт вывоз снега', done: isExporting, active: order.status === OrderStatus.IN_PROGRESS && !isExporting, id: 3, icon: '⌛' },
                   { label: 'Вывоз завершён', done: isFinished, active: order.status === OrderStatus.IN_PROGRESS && isExporting && order.actualTrips >= order.plannedTrips, id: 4 }
                 ];

                 /* Fix: Added explicit typing to groupedRequirements to prevent 'unknown' property errors */
                 const groupedRequirements: AssetRequirement[] = Array.from(
                    order.assetRequirements.reduce((map, req) => {
                      if (!map.has(req.type)) {
                        map.set(req.type, req);
                      }
                      return map;
                    }, new Map<AssetType, AssetRequirement>()).values()
                 );

                 return (
                 <div key={order.id} className="bg-[#12192c]/40 rounded-[3rem] border border-white/5 overflow-hidden backdrop-blur-xl shadow-2xl">
                    <div className="p-10 border-b border-white/5 flex flex-col md:flex-row justify-between items-start gap-6">
                       <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-4 mb-4">
                             {getStatusBadge(order.status)}
                             <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{formatDateTime(order.scheduledTime)}</span>
                          </div>
                          <h2 className="text-4xl font-black tracking-tighter mb-4 leading-none uppercase">{order.address}</h2>
                          <div className="flex gap-2">
                             {groupedRequirements.map((req, i) => (
                               <span key={i} className="text-[9px] font-black text-blue-400 bg-blue-400/10 px-3 py-1 rounded-full uppercase border border-blue-400/20">
                                 {req.type === AssetType.LOADER ? '🚜 ' : '🚛 '}{req.type}
                               </span>
                             ))}
                          </div>
                       </div>
                       
                       <div className="bg-white/5 p-6 rounded-[2rem] border border-white/10 min-w-[240px]">
                          <div className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-3">Ответственный менеджер</div>
                          <div className="flex items-center gap-3 mb-4">
                             <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-black text-xs uppercase shadow-lg border border-blue-400/20">{order.managerName?.charAt(0) || 'А'}</div>
                             <div className="text-sm font-black tracking-tight">{order.managerName || 'Александр'}</div>
                          </div>
                          <div className="flex gap-2">
                             <a href="tel:+70000000000" className="flex-1 bg-white text-slate-900 text-center py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-slate-100 transition-all shadow-lg">Позвонить</a>
                             <button className="flex-1 bg-blue-600 text-white text-center py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-blue-500 transition-all shadow-lg">Написать</button>
                          </div>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2">
                       <div className="p-10 border-r border-white/5 space-y-12">
                          {/* CONFIRMATION BLOCK */}
                          {order.status === OrderStatus.AWAITING_CUSTOMER && (
                            <div className="bg-blue-600 p-10 rounded-[2.5rem] shadow-2xl border-b-[10px] border-blue-800 animate-in zoom-in-95 duration-500">
                               <h3 className="text-2xl font-black uppercase tracking-tighter mb-4">Цены согласованы</h3>
                               <p className="text-[10px] font-bold uppercase tracking-widest opacity-80 leading-relaxed mb-8">
                                  Подтверждаю: цену, технику и план рейсов. <br/>Документы будут доступны сразу после нажатия.
                               </p>
                               <div className="flex flex-col gap-3">
                                  <button onClick={() => handleConfirmOrder(order.id)} className="w-full bg-white text-slate-900 py-5 rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-xl hover:scale-105 transition-all">
                                     ✅ Подтвердить условия
                                  </button>
                                  <div className="flex gap-3">
                                     <button onClick={handleRequestEdits} className="flex-1 bg-blue-700/50 text-white py-4 rounded-2xl text-[9px] font-black uppercase border border-white/20">
                                        ✏️ Правки / Обсудить
                                     </button>
                                     <button onClick={() => handleConfirmOrder(order.id, true)} className="flex-1 bg-orange-500 text-white py-4 rounded-2xl text-[9px] font-black uppercase shadow-lg hover:bg-orange-400 transition-colors">
                                        🚀 СРОЧНО, ЗАПУСКАЙТЕ
                                     </button>
                                  </div>
                               </div>
                               <label className="flex items-center gap-3 mt-6 cursor-pointer">
                                  <input type="checkbox" defaultChecked className="w-4 h-4 rounded bg-white/20 border-none" />
                                  <span className="text-[9px] font-black uppercase opacity-60">Согласен(на) с условиями</span>
                                </label>
                            </div>
                          )}

                          {/* DOCUMENTS BLOCK - APPEARS AFTER CONFIRMATION */}
                          {isConfirmed && (
                            <div className="bg-white/5 p-8 rounded-[2.5rem] border-2 border-green-500/20 shadow-[0_0_40px_rgba(34,197,94,0.1)] animate-in slide-in-from-left-8">
                               <h4 className="text-[10px] font-black text-green-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                                 <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span> Документы на оплату
                               </h4>
                               <div className="space-y-4">
                                  <button onClick={() => handleDownloadDoc('Договор')} className="w-full flex items-center justify-between bg-white text-slate-900 px-6 py-5 rounded-2xl text-[11px] font-black uppercase tracking-tight hover:bg-slate-100 transition-all shadow-xl group">
                                     <span>📄 Скачать Договор</span>
                                     <span className="text-[10px] bg-slate-100 px-2 py-1 rounded-lg text-slate-400 font-bold group-hover:text-blue-600">PDF</span>
                                  </button>
                                  <button onClick={() => handleDownloadDoc('Счёт')} className="w-full flex items-center justify-between bg-white text-slate-900 px-6 py-5 rounded-2xl text-[11px] font-black uppercase tracking-tight hover:bg-slate-100 transition-all shadow-xl group">
                                     <span>📄 Скачать Счёт на оплату</span>
                                     <span className="text-[10px] bg-slate-100 px-2 py-1 rounded-lg text-slate-400 font-bold group-hover:text-blue-600">PDF</span>
                                  </button>
                               </div>
                               <div className="mt-8 p-6 bg-green-500/5 rounded-[1.5rem] border border-green-500/10">
                                  <div className="flex justify-between items-center">
                                     <span className="text-[10px] font-black text-slate-500 uppercase">Текущая сумма к оплате:</span>
                                     <span className="text-xl font-black text-green-400">{orderTotals.grandTotal.toLocaleString()} ₽</span>
                                  </div>
                               </div>
                            </div>
                          )}

                          <div>
                             <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Этапы выполнения</h4>
                             <div className="space-y-4">
                                {steps.map((step, idx) => (
                                  <div key={idx} className={`flex items-center gap-4 p-5 rounded-[1.5rem] border transition-all ${step.done ? 'bg-green-500/10 border-green-500/20 shadow-[inset_0_0_20px_rgba(34,197,94,0.05)]' : step.active ? 'bg-blue-500/10 border-blue-500/40' : 'bg-white/5 border-white/5 opacity-40'}`}>
                                     <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] transition-all shadow-lg ${step.done ? 'bg-green-500 text-white' : step.active ? 'bg-blue-600 text-white ring-4 ring-blue-500/20' : 'bg-slate-800 text-slate-500'}`}>
                                        {step.done ? '✓' : step.active ? (step.icon || '⌛') : step.id}
                                     </div>
                                     <span className={`text-[13px] font-bold tracking-tight ${step.done ? 'text-green-400' : step.active ? 'text-blue-400' : 'text-slate-500'}`}>{step.label}</span>
                                  </div>
                                ))}
                             </div>
                          </div>

                          <div className="bg-[#12192c]/80 p-8 rounded-[2.5rem] border border-white/5 shadow-inner">
                             <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-8">Детали заказа</h4>
                             <div className="space-y-4">
                                {groupedRequirements.map((req, i) => (
                                   <div key={i} className="flex justify-between items-center bg-[#0a0f1d] p-8 rounded-[1.5rem] border border-white/5 shadow-lg group hover:border-blue-500/20 transition-all">
                                      <span className="text-[14px] font-black text-slate-300 uppercase tracking-tight">{req.type}</span>
                                      <div className="text-right">
                                         <div className="text-2xl font-black text-green-400">{req.customerPrice?.toLocaleString() || '—'} ₽</div>
                                         <div className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-1">
                                            {req.type === AssetType.LOADER ? 'смена' : 'рейс'}
                                         </div>
                                      </div>
                                   </div>
                                ))}
                                <div className="flex justify-between items-center bg-[#0a0f1d]/40 p-8 rounded-[1.5rem] border border-dashed border-white/10 mt-2">
                                   <span className="text-[12px] font-bold text-slate-500 uppercase tracking-widest">План по рейсам</span>
                                   <span className="text-xl font-black text-white">{order.plannedTrips} р.</span>
                                </div>
                             </div>
                          </div>
                       </div>

                       <div className="p-10 space-y-12 bg-white/[0.01] backdrop-blur-3xl">
                          {(order.status === OrderStatus.IN_PROGRESS || order.status === OrderStatus.COMPLETED) && (
                             <div>
                                <h4 className="text-[10px] font-black text-green-500 uppercase tracking-widest mb-6">Прогресс работ</h4>
                                <div className="bg-white/5 p-10 rounded-[2.5rem] border border-white/5 mb-6 shadow-2xl relative overflow-hidden">
                                   <div className="absolute top-0 right-0 p-4 opacity-5">🚜</div>
                                   <div className="flex justify-between items-end mb-6">
                                      <div className="text-6xl font-black tracking-tighter">{order.actualTrips || 0} <span className="text-2xl text-slate-600 font-medium">/ {order.plannedTrips}</span></div>
                                      <div className="text-[10px] font-black text-slate-500 uppercase mb-3 tracking-widest">рейсов выполнено</div>
                                   </div>
                                   <div className="w-full h-5 bg-black/40 rounded-full overflow-hidden shadow-inner border border-white/5 p-1">
                                      <div className="h-full bg-blue-600 shadow-[0_0_30px_rgba(37,99,235,0.8)] rounded-full transition-all duration-1000" style={{width: `${Math.min(100, ((order.actualTrips || 0) / order.plannedTrips) * 100)}%`}}></div>
                                   </div>
                                </div>
                             </div>
                          )}

                          <div>
                             <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Фотоотчёты погрузки</h4>
                             {order.evidences && order.evidences.length > 0 ? (
                               <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-h-[500px] overflow-y-auto no-scrollbar pr-2">
                                  {order.evidences.slice().reverse().map((ev, i) => (
                                    <div key={ev.id} className="relative group aspect-[3/4] rounded-2xl overflow-hidden border border-white/10 bg-black/20 shadow-lg">
                                       <img src={ev.photo} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" alt="Report" />
                                       <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent flex flex-col justify-end p-4">
                                          <div className="text-[10px] font-black text-white uppercase mb-0.5">Рейс #{order.evidences.length - i}</div>
                                          <div className="text-[8px] font-bold text-white/50 uppercase tracking-widest">{new Date(ev.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                                       </div>
                                    </div>
                                  ))}
                               </div>
                             ) : (
                               <div className="h-80 rounded-[3rem] border-2 border-white/5 border-dashed flex flex-col items-center justify-center text-center p-12 bg-black/10 shadow-inner group">
                                  <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
                                     <span className="text-4xl opacity-20">📸</span>
                                  </div>
                                  <p className="text-[11px] font-black text-slate-600 uppercase tracking-[0.2em] leading-relaxed">Ожидаем начало работ <br/>и первые фото рейсов</p>
                               </div>
                             )}
                          </div>
                       </div>
                    </div>
                 </div>
               );
              })
             )}
           </div>
        ) : view === 'form' ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-[#12192c]/40 rounded-[2.5rem] border border-white/5 p-10 backdrop-blur-md">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-blue-500 mb-8 flex items-center gap-3">
                1. <span className="text-white opacity-80">Адрес и заказ</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-1">Адрес объекта</label>
                  <div className="relative">
                    <input required type="text" className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm font-medium focus:border-blue-500 outline-none pr-14 transition-all" placeholder="Улица, дом, строение" value={formData.address} onChange={e => setFormData({ ...formData, address: e.target.value })} />
                    <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xl opacity-30">📍</span>
                  </div>
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-1">Когда нужна техника</label>
                  <input required type="datetime-local" className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm font-medium focus:border-blue-500 outline-none transition-all appearance-none" value={formData.scheduledTime} onChange={e => setFormData({ ...formData, scheduledTime: e.target.value })} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-[#12192c]/40 rounded-[2.5rem] border border-white/5 p-10 backdrop-blur-md">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-green-500 mb-8 flex items-center gap-3">
                  2. <span className="text-white opacity-80">Техника и Ограничения</span>
                </h3>
                <div className="space-y-6">
                  {[
                    { label: 'Самосвалы', type: AssetType.TRUCK },
                    { label: 'Погрузчик', type: AssetType.LOADER },
                    { label: 'Трактор / мини-погрузчик', type: AssetType.MINI_LOADER }
                  ].map((item) => (
                    <label key={item.label} className="flex items-center gap-4 cursor-pointer group">
                      <input type="checkbox" className="hidden" checked={formData.assetRequirements?.some(r => r.type === item.type)} onChange={() => toggleAssetType(item.type)} />
                      <div className={`w-6 h-6 rounded-lg border transition-all flex items-center justify-center ${formData.assetRequirements?.some(r => r.type === item.type) ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-[#0a0f1d] border-white/20'}`}>
                        {formData.assetRequirements?.some(r => r.type === item.type) && <span className="text-xs">✓</span>}
                      </div>
                      <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{item.label}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-12 pt-8 border-t border-white/5 space-y-6">
                  {[
                    { label: 'Ограничение по высоте', field: 'hasHeightLimit' },
                    { label: 'Узкий въезд', field: 'hasNarrowEntrance' },
                    { label: 'Пропускной режим', field: 'hasPermitRegime' },
                    { label: 'Работа ночью запрещена', field: 'isNightWorkProhibited' }
                  ].map((item) => (
                    <label key={item.label} className="flex items-center gap-4 cursor-pointer group">
                      <input type="checkbox" className="hidden" checked={(formData.restrictions as any)[item.field]} onChange={(e) => updateRestriction(item.field as any, e.target.checked)} />
                      <div className={`w-6 h-6 rounded-lg border transition-all flex items-center justify-center ${(formData.restrictions as any)[item.field] ? 'bg-blue-600 border-blue-500 text-white shadow-lg' : 'bg-[#0a0f1d] border-white/20'}`}>
                        {(formData.restrictions as any)[item.field] && <span className="text-xs">✓</span>}
                      </div>
                      <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="bg-[#12192c]/40 rounded-[2.5rem] border border-white/5 p-10 backdrop-blur-md flex flex-col">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-cyan-500 mb-8 flex items-center gap-3">
                  3. <span className="text-white opacity-80">Объем и Контакты</span>
                </h3>
                <div className="flex gap-2 mb-8">
                  {[5, 10, 20, 50].map(v => (
                    <button key={v} type="button" onClick={() => setFormData({ ...formData, plannedTrips: v })} className={`flex-1 py-4 rounded-xl font-bold text-sm border transition-all ${formData.plannedTrips === v ? 'bg-[#1c2641] border-blue-500/50 text-white shadow-inner shadow-black/50' : 'bg-[#0a0f1d] border-white/5 text-slate-500 hover:text-white'}`}>{v} р.</button>
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                   <input required type="text" className="bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm focus:border-blue-500 outline-none transition-all placeholder:text-slate-700" placeholder="Ваше имя" value={formData.contactInfo?.name} onChange={e => updateContact('name', e.target.value)} />
                   <input required type="tel" className="bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm focus:border-blue-500 outline-none transition-all placeholder:text-slate-700" placeholder="+7 (___) ___-__-__" value={formData.contactInfo?.phone} onChange={e => updateContact('phone', e.target.value)} />
                </div>
                <textarea className="w-full flex-1 min-h-[120px] bg-[#0a0f1d] border border-white/10 rounded-2xl p-6 text-sm focus:border-blue-500 outline-none placeholder:text-slate-700 transition-all mb-8" placeholder="Комментарий" value={formData.restrictions?.comment} onChange={(e) => updateRestriction('comment', e.target.value)} />
                <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white p-6 rounded-[2rem] text-sm font-black uppercase tracking-widest shadow-2xl border-b-4 border-blue-800 transition-all active:scale-95 shadow-blue-600/20">ОТПРАВИТЬ ЗАЯВКУ МЕНЕДЖЕРУ</button>
              </div>
            </div>
          </form>
        ) : view === 'history' ? (
          <div className="space-y-12 animate-in slide-in-from-right-4 duration-500">
            {completedOrders.length === 0 ? (
              <div className="text-center py-32 opacity-20 bg-[#12192c]/40 rounded-[4rem] border border-white/5 border-dashed">
                <span className="text-7xl block mb-8">❄️</span>
                <p className="text-sm font-black uppercase tracking-widest">История пуста</p>
              </div>
            ) : (
              completedOrders.map(order => {
                const orderTotals = calculateOrderTotals(order);
                
                return (
                  <div key={order.id} className="bg-[#12192c] p-10 rounded-[3rem] border border-white/5 shadow-2xl relative overflow-hidden group">
                    {/* Background Decor */}
                    <div className="absolute top-0 right-0 p-12 opacity-[0.02] transition-opacity group-hover:opacity-10">
                        <span className="text-9xl">🚜</span>
                    </div>

                    <div className="flex justify-between items-start mb-10 relative z-10">
                        <div>
                          <div className="text-[11px] font-black text-blue-500 uppercase tracking-[0.2em] mb-4">ЗАВЕРШЕНО {new Date(order.createdAt).toLocaleDateString()}</div>
                          <h4 className="text-5xl font-black tracking-tighter uppercase leading-none max-w-2xl">{order.address}</h4>
                        </div>
                        <div className="px-6 py-2 rounded-2xl border-2 border-green-500/40 text-green-500 text-[11px] font-black uppercase tracking-[0.3em] flex items-center gap-2 bg-green-500/5 shadow-[0_0_20px_rgba(34,197,94,0.2)]">
                          ВЫПОЛНЕНО
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10">
                        <div className="bg-white/5 p-8 rounded-[2.5rem] border border-white/5 hover:bg-white/[0.08] transition-all">
                          <div className="text-[10px] font-black text-slate-500 uppercase mb-4 tracking-[0.2em]">ИТОГО РЕЙСОВ</div>
                          <div className="text-5xl font-black">{orderTotals.totalTrips}</div>
                        </div>
                        <div className="bg-white/5 p-8 rounded-[2.5rem] border border-white/5 hover:bg-white/[0.08] transition-all">
                          <div className="text-[10px] font-black text-slate-500 uppercase mb-4 tracking-[0.2em]">ИТОГОВАЯ СУММА</div>
                          <div className="text-5xl font-black text-green-400">{orderTotals.grandTotal.toLocaleString()} <span className="text-2xl font-medium">₽</span></div>
                        </div>
                        <button 
                          onClick={() => handleDownloadDoc('Полный комплект')}
                          className="bg-white text-slate-900 p-8 rounded-[2.5rem] flex items-center justify-center gap-4 shadow-2xl hover:scale-[1.02] active:scale-95 transition-all border-b-[8px] border-slate-200"
                        >
                          <span className="text-3xl">📄</span>
                          <span className="text-[12px] font-black uppercase tracking-widest text-left leading-tight">СКАЧАТЬ АКТ И ФОТО</span>
                        </button>
                    </div>

                    {/* Secondary Documents & Actions */}
                    <div className="mt-12 pt-10 border-t border-white/5">
                        <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-6">Документы и экспорт</h5>
                        <div className="flex flex-wrap gap-4">
                          <button onClick={() => handleDownloadDoc('Акт (PDF)')} className="px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/10 text-[9px] font-black uppercase tracking-widest transition-all">Акт выполненных работ (PDF)</button>
                          <button onClick={() => handleDownloadDoc('Счёт-фактура')} className="px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/10 text-[9px] font-black uppercase tracking-widest transition-all">Счёт-фактура</button>
                          <button onClick={() => handleDownloadDoc('Реестр')} className="px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/10 text-[9px] font-black uppercase tracking-widest transition-all">Реестр рейсов (Table)</button>
                          <button onClick={() => handleDownloadDoc('Архив фото')} className="px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/10 text-[9px] font-black uppercase tracking-widest transition-all">Фотоотчёт (Archive)</button>
                        </div>
                        <div className="flex gap-4 mt-8">
                          <button 
                              onClick={() => handleSendToSocial('telegram')}
                              className="flex-1 bg-blue-600/10 hover:bg-blue-600 hover:text-white border border-blue-500/20 py-4 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3"
                          >
                              <span>✈️</span> Отправить в Telegram
                          </button>
                          <button 
                              onClick={() => handleSendToSocial('email')}
                              className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 py-4 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3"
                          >
                              <span>✉️</span> На почту
                          </button>
                        </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="text-center py-20 opacity-20">Раздел в разработке</div>
        )}
      </div>
    </div>
  );
};

export default CustomerPortal;
