
import React, { useState, useEffect, useMemo } from 'react';
import { Order, OrderStatus, ManagerName, DEFAULT_MANAGERS, Contractor, TripEvidence, DriverAssignment, AssetType, Customer, PaymentType } from './types';
import OrderForm from './components/OrderForm';
import ContractorForm from './components/ContractorForm';
import CustomerFormDispatcher from './components/CustomerForm_Dispatcher';
import DriverPortal from './components/DriverPortal';
import CustomerPortal from './components/CustomerPortal';
import MapDashboard from './components/MapDashboard';
import { getOrderInsights } from './services/geminiService';

const INITIAL_CONTRACTORS: Contractor[] = [
  { id: 'c1', name: 'ООО "СпецТех"', equipment: ['Погрузчик', 'Самосвал 20м3'], comments: 'Надежные ребята, работают в ночную смену. Есть НДС.', phone: '+7 (999) 123-45-67' },
  { id: 'c2', name: 'ИП Иванов А.С.', equipment: ['Самосвал 15м3'], comments: 'Берут только наличные. Быстрая подача в ЦАО.', phone: '+7 (900) 000-00-00' }
];

const INITIAL_CUSTOMERS: Customer[] = [
  { id: 'cust1', name: 'ООО "ГлобалСтрой"', phone: '+7 (900) 111-22-33', email: 'global@build.ru', inn: '7700112233', paymentType: PaymentType.VAT_20, comment: 'Крупный застройщик' },
  { id: 'cust2', name: 'ТСЖ "Московское"', phone: '+7 (495) 000-00-01', email: 'info@mos-tszh.ru', inn: '7744005511', paymentType: PaymentType.CASH, comment: 'Оплата день в день' }
];

const INITIAL_ORDERS: Order[] = [
  {
    id: '1',
    customer: 'ООО "ГлобалСтрой"',
    customerId: 'cust1',
    address: 'Тверская ул., 13',
    coordinates: [55.7592, 37.6085],
    assetRequirements: [
      { type: AssetType.LOADER, contractorId: 'c1', contractorName: 'ООО "СпецТех"', plannedUnits: 1, customerPrice: 15000, birzhaPrice: 12000 },
      { type: AssetType.TRUCK, contractorId: '', contractorName: 'Биржа', plannedUnits: 2, customerPrice: 7000, birzhaPrice: 5000 }
    ],
    isBirzhaOpen: true,
    applicants: [],
    assignedDrivers: [],
    driverDetails: [],
    plannedTrips: 10,
    actualTrips: 0,
    scheduledTime: new Date().toISOString(),
    isPaid: false,
    status: OrderStatus.CONFIRMED_BY_CUSTOMER,
    managerName: 'АЛЕКСАНДР',
    createdAt: new Date().toISOString(),
    evidences: [],
    restrictions: {
      hasHeightLimit: true,
      hasNarrowEntrance: false,
      hasPermitRegime: true,
      isNightWorkProhibited: false,
      comment: 'Низкая арка на въезде'
    }
  }
];

const App: React.FC = () => {
  const [role, setRole] = useState<'manager' | 'driver' | 'customer'>(() => {
    const saved = localStorage.getItem('snow_role');
    return (saved as any) || 'manager';
  });

  const [currentDriverContractorId, setCurrentDriverContractorId] = useState(() => {
    return localStorage.getItem('snow_driver_contractor_id') || '';
  });

  const [orders, setOrders] = useState<Order[]>(() => {
    const saved = localStorage.getItem('snow_orders');
    return saved ? JSON.parse(saved) : INITIAL_ORDERS;
  });

  const [contractors, setContractors] = useState<Contractor[]>(() => {
    const saved = localStorage.getItem('snow_contractors');
    return saved ? JSON.parse(saved) : INITIAL_CONTRACTORS;
  });

  const [customers, setCustomers] = useState<Customer[]>(() => {
    const saved = localStorage.getItem('snow_customers_base');
    return saved ? JSON.parse(saved) : INITIAL_CUSTOMERS;
  });

  const [managers, setManagers] = useState<ManagerName[]>(() => {
    const saved = localStorage.getItem('snow_managers');
    return saved ? JSON.parse(saved) : DEFAULT_MANAGERS;
  });

  const [currentUser, setCurrentUser] = useState<ManagerName>(managers[0] || 'Система');
  const [newManagerName, setNewManagerName] = useState('');
  
  const [isOrderFormOpen, setIsOrderFormOpen] = useState(false);
  const [isContractorFormOpen, setIsContractorFormOpen] = useState(false);
  const [isCustomerFormOpen, setIsCustomerFormOpen] = useState(false);
  
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  
  const [activeTab, setActiveTab] = useState<'list' | 'contractors' | 'managers' | 'customers' | 'map'>('list');
  const [aiReport, setAiReport] = useState<string>('');
  const [isAiLoading, setIsAiLoading] = useState(false);

  const currentIdentityName = useMemo(() => {
    const contractor = contractors.find(c => c.id === currentDriverContractorId);
    return contractor ? contractor.name : 'Частный водитель';
  }, [contractors, currentDriverContractorId]);

  useEffect(() => {
    localStorage.setItem('snow_orders', JSON.stringify(orders));
  }, [orders]);

  useEffect(() => {
    localStorage.setItem('snow_contractors', JSON.stringify(contractors));
  }, [contractors]);

  useEffect(() => {
    localStorage.setItem('snow_customers_base', JSON.stringify(customers));
  }, [customers]);

  useEffect(() => {
    localStorage.setItem('snow_managers', JSON.stringify(managers));
  }, [managers]);

  const handleAddOrder = (data: Partial<Order>) => {
    const isFromCustomer = role === 'customer';
    const newOrder: Order = {
      ...data as Order,
      id: Math.random().toString(36).substr(2, 9),
      createdAt: new Date().toISOString(),
      managerName: isFromCustomer ? 'Входящая' : currentUser,
      evidences: [],
      assignedDrivers: [],
      driverDetails: [],
      applicants: [],
      actualTrips: 0,
      isBirzhaOpen: false, 
      coordinates: [55.75 + (Math.random() - 0.5) * 0.2, 37.6 + (Math.random() - 0.5) * 0.2],
      status: isFromCustomer ? OrderStatus.WAITING_APPROVAL : OrderStatus.SENT,
      assetRequirements: data.assetRequirements || [{ type: AssetType.TRUCK, contractorId: '', contractorName: 'Биржа', plannedUnits: 1, customerPrice: 0, birzhaPrice: 0 }],
      restrictions: data.restrictions || {
        hasHeightLimit: false,
        hasNarrowEntrance: false,
        hasPermitRegime: false,
        isNightWorkProhibited: false,
        comment: ''
      }
    };
    setOrders(prev => [newOrder, ...prev]);
    setIsOrderFormOpen(false);
  };

  const handleUpdateOrder = (data: Partial<Order>) => {
    const orderId = data.id || editingOrder?.id;
    if (!orderId) {
      handleAddOrder(data);
      return;
    }

    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        const updated = { ...o, ...data };
        if (data.status === OrderStatus.IN_PROGRESS) {
           updated.isBirzhaOpen = false;
        }
        return updated;
      }
      return o;
    }));
    setEditingOrder(null);
    setIsOrderFormOpen(false);
  };

  const handleUpsertContractor = (data: Contractor) => {
    setContractors(prev => {
      const exists = prev.some(c => c.id === data.id);
      if (exists) {
        return prev.map(c => c.id === data.id ? data : c);
      }
      return [data, ...prev];
    });
    setEditingContractor(null);
    setIsContractorFormOpen(false);
  };

  const handleUpsertCustomer = (data: Customer) => {
    setCustomers(prev => {
      const exists = prev.some(c => c.id === data.id);
      if (exists) return prev.map(c => c.id === data.id ? data : c);
      return [data, ...prev];
    });
    setEditingCustomer(null);
    setIsCustomerFormOpen(false);
  };

  const handleDriverTrip = (orderId: string, evidence: TripEvidence) => {
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        return {
          ...o,
          // Removed auto-increment. Now it waits for manager approval.
          evidences: [...(o.evidences || []), { ...evidence, confirmed: false }],
          status: o.status === OrderStatus.CONFIRMED_BY_CUSTOMER ? OrderStatus.IN_PROGRESS : o.status
        };
      }
      return o;
    }));
  };

  const handleConfirmTrip = (orderId: string, evidenceId: string) => {
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        const updatedEvidences = o.evidences.map(e => e.id === evidenceId ? { ...e, confirmed: true } : e);
        // Recalculate actual trips based on confirmed evidences
        const newActualTrips = updatedEvidences.filter(e => e.confirmed).length;
        
        return {
          ...o,
          evidences: updatedEvidences,
          actualTrips: newActualTrips
        };
      }
      return o;
    }));
  };

  const handleAcceptJob = (orderId: string, driverContractorId: string, assetType: AssetType) => {
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        if (!o.applicants.some(a => a.driverName === currentIdentityName && a.assetType === assetType)) {
           const directSlot = o.assetRequirements.find(ar => ar.type === assetType && ar.contractorId === driverContractorId);
           const birzhaSlot = o.assetRequirements.find(ar => ar.type === assetType && (!ar.contractorId || ar.contractorId === ''));
           
           const targetSlot = directSlot || birzhaSlot;
           if (!targetSlot) return o;

           return {
             ...o,
             applicants: [...o.applicants, { 
               driverName: currentIdentityName, 
               contractorId: driverContractorId, 
               assetType: assetType,
               acceptedPrice: targetSlot.birzhaPrice || 0 
             }]
           };
        }
      }
      return o;
    }));
  };

  const handleDriverFinishWork = (orderId: string) => {
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        return {
          ...o,
          assignedDrivers: o.assignedDrivers.filter(d => d !== currentIdentityName),
          driverDetails: (o.driverDetails || []).filter(d => d.driverName !== currentIdentityName)
        };
      }
      return o;
    }));
  };

  const handleAddManager = () => {
    const trimmed = newManagerName.trim();
    if (trimmed && !managers.includes(trimmed)) {
      setManagers(prev => [...prev, trimmed]);
      setNewManagerName('');
    }
  };

  const stats = useMemo(() => {
    const totalTrips = orders.reduce((sum, o) => sum + (o.plannedTrips || 0), 0);
    const actualTrips = orders.reduce((sum, o) => sum + (o.actualTrips || 0), 0);
    const activeObjects = orders.filter(o => o.status === OrderStatus.IN_PROGRESS).length;
    return { totalTrips, actualTrips, activeObjects };
  }, [orders]);

  const getAiInsights = async () => {
    setIsAiLoading(true);
    const report = await getOrderInsights(orders);
    setAiReport(report);
    setIsAiLoading(false);
  };

  if (role === 'driver') {
    return (
      <div className="h-screen bg-[#0a0f1d] overflow-hidden relative">
        <DriverPortal 
          orders={orders} 
          contractors={contractors}
          driverName={currentIdentityName}
          driverContractorId={currentDriverContractorId}
          onReportTrip={handleDriverTrip} 
          onAcceptJob={handleAcceptJob}
          onFinishWork={handleDriverFinishWork}
        />
        <div className="fixed bottom-0 left-0 right-0 bg-[#0a0f1d]/90 backdrop-blur-3xl p-6 flex flex-col gap-4 z-[200] border-t border-white/10 shadow-[0_-40px_80px_rgba(0,0,0,0.8)]">
          <div className="flex gap-6 items-center max-w-4xl mx-auto w-full">
              <div className="flex-1 space-y-1">
                <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest ml-2">ВХОД В КАБИНЕТ ОРГАНИЗАЦИИ</label>
                <div className="relative group">
                  <select 
                    className="w-full bg-white/5 px-8 py-5 rounded-3xl text-white text-[13px] font-black border border-white/10 outline-none appearance-none transition-all cursor-pointer shadow-2xl hover:bg-white/10 focus:ring-4 focus:ring-blue-500/20"
                    value={currentDriverContractorId}
                    onChange={(e) => {
                      const cid = e.target.value;
                      setCurrentDriverContractorId(cid);
                      localStorage.setItem('snow_driver_contractor_id', cid);
                    }}
                  >
                    <option value="" className="bg-[#12192c]">Частный извоз</option>
                    {contractors.map(c => <option key={c.id} value={c.id} className="bg-[#12192c]">{c.name}</option>)}
                  </select>
                  <div className="absolute right-6 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">▼</div>
                </div>
              </div>
              <button onClick={() => {
                setRole('manager');
                localStorage.setItem('snow_role', 'manager');
              }} className="mt-5 bg-white text-slate-900 px-8 py-5 rounded-3xl text-sm font-black uppercase tracking-widest shadow-2xl active:scale-95 transition-all h-[64px] flex items-center gap-3">
                <span>🛠️ ДИСПЕТЧЕР</span>
              </button>
          </div>
          <p className="text-[8px] text-center text-slate-600 font-black uppercase tracking-[0.6em] opacity-40">SNOWFORCE DISPATCH v2.7 • МОСКВА</p>
        </div>
      </div>
    );
  }

  if (role === 'customer') {
    return (
      <div className="h-screen overflow-hidden flex flex-col bg-[#0a0f1d]">
        <CustomerPortal orders={orders} onAddOrder={handleAddOrder} onUpdateOrder={(id, updates) => setOrders(prev => prev.map(o => o.id === id ? {...o, ...updates} : o))} />
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200]">
           <button onClick={() => {
             setRole('manager');
             localStorage.setItem('snow_role', 'manager');
           }} className="bg-white text-slate-900 px-10 py-5 rounded-full text-[10px] font-black uppercase tracking-widest shadow-2xl active:scale-95 transition-all border-b-4 border-slate-200">
             🛠️ ВЕРНУТЬСЯ К ДИСПЕТЧЕРУ
           </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-100 font-['Inter']">
      <header className="bg-[#0a0f1d] text-white p-4 shadow-2xl z-50 border-b border-white/10">
        <div className="container mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center space-x-4 cursor-pointer" onClick={() => setActiveTab('list')}>
            <div className="text-4xl">❄️</div>
            <div>
              <h1 className="text-2xl font-black tracking-tighter uppercase leading-none">SnowForce</h1>
              <p className="text-[10px] text-blue-500 font-black uppercase tracking-[0.3em] mt-1">Dispatcher Hub</p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center justify-center gap-4">
            <button onClick={() => { setRole('customer'); localStorage.setItem('snow_role', 'customer'); }} className="bg-[#1c2641] text-[10px] font-black uppercase tracking-widest px-6 py-3 rounded-2xl hover:bg-red-600/20 border border-white/10 transition-all">Личный кабинет заказчика</button>
            <button onClick={() => { setRole('driver'); localStorage.setItem('snow_role', 'driver'); }} className="bg-[#1c2641] text-[10px] font-black uppercase tracking-widest px-6 py-3 rounded-2xl border border-white/10 flex items-center gap-2 hover:bg-blue-600/20 transition-all">🚚 Кабинет водителя</button>
            
            <div className="flex items-center bg-[#1c2641] p-1 rounded-2xl border border-white/5 ml-2 relative overflow-hidden group">
              <div className="flex overflow-x-auto no-scrollbar max-w-[200px] gap-1">
                {managers.map(m => (
                  <button key={m} onClick={() => setCurrentUser(m)} className={`px-4 py-2 text-[10px] font-black uppercase rounded-xl transition-all whitespace-nowrap ${currentUser === m ? 'bg-white text-slate-900 shadow-xl' : 'text-slate-500 hover:text-white'}`}>{m}</button>
                ))}
              </div>
              <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-[#1c2641] to-transparent pointer-events-none"></div>
            </div>

            <button onClick={() => { setEditingOrder(null); setIsOrderFormOpen(true); }} className="bg-blue-600 text-white px-8 py-3.5 rounded-2xl text-[12px] font-black uppercase tracking-widest shadow-[0_10px_30px_rgba(37,99,235,0.4)] hover:bg-blue-500 active:scale-95 transition-all">
              + Объект
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto p-4 flex flex-col gap-8 pb-32 mt-6">
        <div className="flex bg-[#e2e8f0] p-1.5 rounded-[2rem] w-fit shadow-inner border border-slate-300">
          {[
            { id: 'list', label: 'ОБЪЕКТЫ' }, 
            { id: 'map', label: 'КАРТА' },
            { id: 'contractors', label: 'ПОДРЯДЧИКИ' }, 
            { id: 'managers', label: 'КОМАНДА' },
            { id: 'customers', label: 'ЗАКАЗЧИКИ' }
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} className={`px-10 py-3 rounded-[1.5rem] text-[11px] font-black uppercase tracking-widest transition-all ${activeTab === tab.id ? 'bg-white shadow-xl text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}>{tab.label}</button>
          ))}
        </div>

        {activeTab === 'list' ? (
          <div className="flex flex-col gap-8 animate-in fade-in duration-500">
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white p-10 rounded-[2.5rem] border-b-[10px] border-b-blue-500 shadow-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-6 opacity-[0.03] text-6xl group-hover:scale-125 transition-transform">🚛</div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Общий Тоннаж / Рейсы</p>
                <div className="flex items-baseline space-x-3">
                   <span className="text-6xl font-black text-slate-900">{stats.actualTrips || 0}</span>
                   <span className="text-xs text-slate-400 font-bold uppercase">/ {stats.totalTrips || 0} по плану</span>
                </div>
              </div>
              <div className="bg-white p-10 rounded-[2.5rem] border-b-[10px] border-b-orange-500 shadow-2xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-6 opacity-[0.03] text-6xl group-hover:scale-125 transition-transform">📍</div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Объекты в работе</p>
                <span className="text-6xl font-black text-orange-600">{stats.activeObjects}</span>
              </div>
              <div className="bg-white p-10 rounded-[2.5rem] border-b-[10px] border-b-purple-500 shadow-2xl relative overflow-hidden group">
                 <div className="absolute top-0 right-0 p-6 opacity-[0.03] text-6xl group-hover:scale-125 transition-transform">📸</div>
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">На проверке</p>
                 <span className="text-6xl font-black text-purple-600">
                    {orders.reduce((acc, o) => acc + (o.evidences.filter(e => !e.confirmed).length), 0)}
                 </span>
              </div>
              <div className="bg-[#0a0f1d] p-10 rounded-[2.5rem] text-white shadow-2xl flex flex-col justify-between group cursor-pointer hover:scale-[1.02] transition-all border border-white/5">
                <p className="text-[10px] font-black text-blue-400 uppercase tracking-[0.4em] mb-4">AI LOGISTICS ANALYTICS</p>
                <button onClick={getAiInsights} className="text-xs font-black uppercase tracking-widest text-left border-b border-blue-500/50 pb-2 group-hover:text-blue-300 transition-colors">
                  {isAiLoading ? 'Синхронизация данных...' : 'СФОРМИРОВАТЬ ОТЧЕТ'}
                </button>
              </div>
            </div>

            {aiReport && (
              <div className="bg-blue-600 text-white p-12 rounded-[3rem] shadow-2xl animate-in zoom-in-95 duration-300 relative border-b-[12px] border-blue-800">
                <h3 className="text-white font-black text-[11px] uppercase tracking-[0.4em] mb-8 flex items-center">
                  <span className="w-3 h-3 bg-white rounded-full animate-ping mr-4 shadow-[0_0_10px_white]"></span>
                  АНАЛИТИЧЕСКИЙ ОТЧЕТ СИСТЕМЫ SNOWFORCE
                </h3>
                <p className="text-lg leading-relaxed text-blue-50 whitespace-pre-wrap font-medium">{aiReport}</p>
                <button onClick={() => setAiReport('')} className="mt-10 text-[10px] font-black text-white/50 uppercase tracking-widest hover:text-white transition-colors">Свернуть аналитику ×</button>
              </div>
            )}

            <div className="bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50/80 border-b border-slate-200">
                    <tr>
                      <th className="px-10 py-8 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] min-w-[300px]">ЛОКАЦИЯ / КЛИЕНТ</th>
                      <th className="px-10 py-8 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">ПРОГРЕСС РЕЙСОВ</th>
                      <th className="px-10 py-8 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">СТАТУС ТЕХНИКИ</th>
                      <th className="px-10 py-8 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] text-right">СТАТУС</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {orders.map(order => {
                      const isWaiting = [OrderStatus.SENT, OrderStatus.WAITING_APPROVAL, OrderStatus.AWAITING_CUSTOMER].includes(order.status as OrderStatus);
                      const pendingConfirmations = order.evidences.filter(e => !e.confirmed).length;
                      
                      const assignedDrivers = order.driverDetails || [];
                      const totalPlannedSlots = order.assetRequirements.reduce((sum, r) => sum + r.plannedUnits, 0);
                      const remainingSlots = Math.max(0, totalPlannedSlots - assignedDrivers.length);

                      return (
                        <tr key={order.id} className={`hover:bg-blue-50/50 cursor-pointer transition-all ${isWaiting ? 'bg-orange-50/20' : ''}`} onClick={() => { setEditingOrder(order); setIsOrderFormOpen(true); }}>
                          <td className="px-10 py-10">
                            <div className="text-[11px] font-black text-blue-600 uppercase mb-2 tracking-tighter">{order.customer || 'Новый клиент'}</div>
                            <div className="font-black text-slate-900 text-xl leading-none uppercase tracking-tight mb-3">{order.address}</div>
                            <div className="flex flex-wrap items-center gap-3">
                               <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">{new Date(order.scheduledTime).toLocaleString('ru', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}</span>
                               <div className="flex gap-1.5">
                                  {order.restrictions?.hasHeightLimit && <span title="Высота" className="text-[10px] bg-slate-900 text-white w-6 h-6 flex items-center justify-center rounded-lg shadow-sm">↕️</span>}
                                  {order.restrictions?.hasNarrowEntrance && <span title="Узкий въезд" className="text-[10px] bg-slate-900 text-white w-6 h-6 flex items-center justify-center rounded-lg shadow-sm">↔️</span>}
                                  {order.restrictions?.hasPermitRegime && <span title="Пропуск" className="text-[10px] bg-slate-900 text-white w-6 h-6 flex items-center justify-center rounded-lg shadow-sm">🎫</span>}
                                  {order.restrictions?.isNightWorkProhibited && <span title="Ночь запрещена" className="text-[10px] bg-slate-900 text-white w-6 h-6 flex items-center justify-center rounded-lg shadow-sm">🌙</span>}
                               </div>
                            </div>
                          </td>
                          <td className="px-10 py-10">
                            <div className="flex flex-col gap-4">
                              <div className="flex items-center space-x-6">
                                <span className="text-3xl font-black text-slate-900">{order.actualTrips || 0} <span className="text-[11px] text-slate-400 font-bold uppercase ml-1">/ {order.plannedTrips || 0}</span></span>
                                <div className="flex-1 h-3.5 bg-slate-100 rounded-full overflow-hidden w-40 shadow-inner border border-white">
                                    <div className={`h-full transition-all duration-1000 ${order.actualTrips >= order.plannedTrips ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : 'bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.4)]'}`} style={{ width: `${order.plannedTrips > 0 ? Math.min(100, (order.actualTrips / order.plannedTrips) * 100) : 0}%` }}></div>
                                </div>
                              </div>
                              {pendingConfirmations > 0 && (
                                <div className="inline-flex items-center gap-2 bg-orange-100 text-orange-600 px-3 py-1.5 rounded-lg border border-orange-200 animate-pulse">
                                   <span className="text-[10px] font-black uppercase">⚠️ Нужно подтвердить: {pendingConfirmations}</span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-10 py-10">
                            <div className="flex flex-wrap gap-2.5 max-w-[400px]">
                              {/* 1. Render Assigned Drivers once (Confirmed by manager) */}
                              {assignedDrivers.map((assignment, i) => {
                                const isTruck = assignment.assetType === AssetType.TRUCK;
                                const tripsDone = (order.evidences || []).filter(e => e.driverName === assignment.driverName && e.confirmed).length;
                                const workText = isTruck ? `${tripsDone} Р.` : 'СМЕНА';
                                const isApproved = assignment.tripsConfirmed;
                                
                                return (
                                  <div key={`assigned-${assignment.driverName}-${i}`} className="flex flex-col items-center gap-1">
                                    <div className={`text-[9px] font-black px-4 py-2 rounded-xl uppercase border shadow-md flex items-center gap-2 ${assignment.assetType === AssetType.LOADER ? 'bg-orange-500 text-white border-orange-600' : 'bg-blue-600 text-white border-blue-700'}`}>
                                      <span className="text-[12px]">{assignment.assetType === AssetType.LOADER ? '🚜' : '🚛'}</span>
                                      <span className="whitespace-nowrap uppercase">{assignment.driverName} ({workText})</span>
                                    </div>
                                    <span className={`text-[7px] font-black uppercase tracking-widest text-center leading-none mt-0.5 ${isApproved ? 'text-green-600' : 'text-orange-500 italic'}`}>
                                      {isApproved ? 'УТВЕРЖДЕНО' : 'ОЖИДАНИЕ'}
                                    </span>
                                  </div>
                                );
                              })}

                              {/* 2. Render Search Placeholders if Exchange is open */}
                              {order.isBirzhaOpen && remainingSlots > 0 && Array.from({length: remainingSlots}).map((_, i) => (
                                <div key={`search-placeholder-${i}`} className="flex flex-col items-center gap-1">
                                  <span className="text-[9px] font-black bg-slate-50 text-slate-300 px-4 py-2 rounded-xl uppercase border border-slate-100 animate-pulse flex items-center gap-2">
                                    <span className="text-[12px] opacity-40">🚛</span> поиск...
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="px-10 py-10 text-right">
                            <span className={`px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] shadow-lg inline-block ${order.status === OrderStatus.COMPLETED ? 'bg-green-100 text-green-700 border border-green-200' : order.status === OrderStatus.IN_PROGRESS ? 'bg-blue-100 text-blue-700 border border-blue-200' : order.status === OrderStatus.AWAITING_CUSTOMER ? 'bg-orange-600 text-white shadow-orange-500/20' : 'bg-orange-50 text-orange-700 border border-orange-100'}`}>{order.status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeTab === 'map' ? (
          <MapDashboard orders={orders} onSelectOrder={(o) => { setEditingOrder(o); setIsOrderFormOpen(true); }} />
        ) : activeTab === 'contractors' ? (
          <div className="space-y-8 animate-in slide-in-from-bottom-6 duration-500">
             <div className="flex justify-between items-center bg-white p-8 rounded-[2rem] shadow-xl border border-slate-200">
              <div><h2 className="text-3xl font-black text-slate-900 uppercase tracking-tighter">БАЗА ТЕХНИКИ</h2></div>
              <button onClick={() => { setEditingContractor(null); setIsContractorFormOpen(true); }} className="bg-[#0a0f1d] text-white px-10 py-4 rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-2xl hover:bg-black transition-all">+ ДОБАВИТЬ ПОДРЯДЧИКА</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {contractors.map(c => (
                <div key={c.id} className="bg-white p-10 rounded-[3rem] border border-slate-200 shadow-xl hover:shadow-2xl transition-all group relative overflow-hidden">
                  <div className="relative z-10">
                    <div className="flex justify-between items-start mb-8">
                      <div>
                        <h3 className="font-black text-2xl text-slate-900 leading-none uppercase tracking-tight group-hover:text-blue-600 transition-colors">{c.name}</h3>
                        <a href={`tel:${c.phone}`} className="text-[11px] text-blue-600 font-black hover:underline mt-3 block tracking-widest">{c.phone}</a>
                      </div>
                      <button onClick={() => { setEditingContractor(c); setIsContractorFormOpen(true); }} className="p-4 text-slate-300 hover:text-blue-600 bg-slate-50 rounded-[1.5rem] transition-all border border-slate-100">✏️</button>
                    </div>
                    <div className="flex flex-wrap gap-2.5 mb-6">
                      {c.equipment.map(e => (
                        <span key={e} className="bg-slate-900 text-white text-[10px] px-4 py-1.5 rounded-full font-black uppercase tracking-tighter shadow-sm">{e}</span>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400 italic font-medium leading-relaxed">{c.comments || 'Нет примечаний'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : activeTab === 'customers' ? (
          <div className="space-y-8 animate-in slide-in-from-bottom-6 duration-500">
             <div className="flex justify-between items-center bg-white p-8 rounded-[2rem] shadow-xl border border-slate-200">
              <div><h2 className="text-3xl font-black text-slate-900 uppercase tracking-tighter">БАЗА ЗАКАЗЧИКОВ</h2></div>
              <button onClick={() => { setEditingCustomer(null); setIsCustomerFormOpen(true); }} className="bg-blue-600 text-white px-10 py-4 rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-2xl hover:bg-blue-500 transition-all">+ НОВЫЙ ЗАКАЗЧИК</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {customers.map(c => (
                <div key={c.id} className="bg-white p-12 rounded-[3.5rem] border border-slate-200 shadow-xl hover:shadow-2xl transition-all relative overflow-hidden group">
                  <div className="flex justify-between items-start mb-8">
                    <div>
                      <h3 className="font-black text-2xl text-slate-900 uppercase tracking-tighter mb-2 group-hover:text-blue-600 transition-colors">{c.name}</h3>
                      <div className="text-[10px] font-black text-blue-500 uppercase tracking-[0.2em]">{c.paymentType}</div>
                    </div>
                    <button onClick={() => { setEditingCustomer(c); setIsCustomerFormOpen(true); }} className="p-4 text-slate-300 hover:text-blue-600 bg-slate-50 rounded-2xl transition-all border border-slate-100">✏️</button>
                  </div>
                  <div className="space-y-5 mb-8">
                     <div className="flex items-center gap-4">
                        <span className="text-2xl">📞</span>
                        <a href={`tel:${c.phone}`} className="text-sm font-black text-slate-700 hover:underline">{c.phone}</a>
                     </div>
                     <div className="flex items-center gap-4">
                        <span className="text-2xl">📑</span>
                        <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">ИНН: {c.inn}</span>
                     </div>
                  </div>
                  <div className="pt-8 border-t border-slate-100">
                     <p className="text-[11px] text-slate-400 font-medium italic leading-relaxed">{c.comment || 'Нет примечаний'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto w-full">
            <div className="bg-white p-12 rounded-[4rem] border border-slate-200 shadow-2xl">
              <h2 className="text-3xl font-black text-slate-900 mb-10 uppercase tracking-tighter text-center">КОМАНДА ДИСПЕТЧЕРОВ</h2>
              <div className="flex gap-4 mb-12">
                <input type="text" placeholder="ИМЯ СОТРУДНИКА..." className="flex-1 rounded-2xl border-slate-200 bg-slate-50 p-6 text-sm font-black focus:ring-4 focus:ring-blue-500/20 outline-none uppercase placeholder:text-slate-300" value={newManagerName} onChange={e => setNewManagerName(e.target.value)} onKeyPress={e => e.key === 'Enter' && handleAddManager()} />
                <button onClick={handleAddManager} className="bg-slate-900 text-white px-10 py-6 rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-xl hover:bg-black transition-all">ПРИНЯТЬ</button>
              </div>
              <div className="grid grid-cols-1 gap-5">
                {managers.map(m => (
                  <div key={m} className="flex items-center justify-between p-6 bg-slate-50 rounded-[2rem] border border-slate-100 hover:border-blue-400 hover:bg-white transition-all group shadow-sm">
                    <div className="flex items-center space-x-6">
                      <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-black text-xl uppercase shadow-xl shadow-blue-200 border-b-4 border-blue-800">{m.charAt(0)}</div>
                      <span className="font-black text-slate-800 text-lg tracking-tight uppercase">{m}</span>
                    </div>
                    <div className="w-3 h-3 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {isOrderFormOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-[#0a0f1d]/95 backdrop-blur-2xl overflow-y-auto">
          <div className="w-full max-w-5xl py-12">
            <OrderForm 
              currentUser={currentUser} 
              contractors={contractors} 
              customers={customers}
              allOrders={orders} 
              initialData={editingOrder || undefined} 
              onCancel={() => { setIsOrderFormOpen(false); setEditingOrder(null); }} 
              onAddContractor={() => { setIsContractorFormOpen(true); }} 
              onAddCustomer={() => { setIsCustomerFormOpen(true); }}
              onSubmit={handleUpdateOrder} 
            />
          </div>
        </div>
      )}

      {isContractorFormOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-[#0a0f1d]/90 backdrop-blur-xl overflow-y-auto">
          <div className="w-full max-w-xl">
            <ContractorForm initialData={editingContractor || undefined} onCancel={() => { setIsContractorFormOpen(false); setEditingContractor(null); }} onSubmit={handleUpsertContractor} />
          </div>
        </div>
      )}

      {isCustomerFormOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-[#0a0f1d]/90 backdrop-blur-xl overflow-y-auto">
          <div className="w-full max-w-2xl">
            <CustomerFormDispatcher initialData={editingCustomer || undefined} onCancel={() => { setIsCustomerFormOpen(false); setEditingCustomer(null); }} onSubmit={handleUpsertCustomer} />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
