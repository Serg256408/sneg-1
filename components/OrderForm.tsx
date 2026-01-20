
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Order, OrderStatus, ManagerName, Contractor, AssetRequirement, AssetType, Customer, DriverAssignment } from '../types';

interface OrderFormProps {
  initialData?: Order;
  contractors: Contractor[];
  customers: Customer[];
  allOrders: Order[]; 
  onSubmit: (data: Partial<Order>) => void;
  onCancel: () => void;
  onAddContractor: () => void;
  onAddCustomer: () => void;
  currentUser: ManagerName;
}

const OrderForm: React.FC<OrderFormProps> = ({ 
  initialData, 
  contractors, 
  customers,
  onSubmit, 
  onCancel, 
  currentUser 
}) => {
  const [formData, setFormData] = useState<Partial<Order>>(initialData || {
    customer: '',
    address: '',
    assetRequirements: [],
    plannedTrips: 5,
    scheduledTime: new Date().toISOString().slice(0, 16),
    status: OrderStatus.SENT,
    managerName: currentUser,
    isBirzhaOpen: false,
    isFrozen: false,
    evidences: [],
    assignedDrivers: [],
    driverDetails: [],
    applicants: [],
    actualTrips: 0
  });

  const [customerSearch, setCustomerSearch] = useState(initialData?.customer || '');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Logic: Contextual actions
  const hasDirectOffers = useMemo(() => formData.assetRequirements?.some(r => r.contractorId), [formData.assetRequirements]);
  const hasBirzhaSlots = useMemo(() => formData.assetRequirements?.some(r => !r.contractorId), [formData.assetRequirements]);
  const isApprovedByCustomer = formData.status === OrderStatus.CONFIRMED_BY_CUSTOMER || formData.status === OrderStatus.IN_PROGRESS;
  const hasApplicants = useMemo(() => (formData.applicants || []).length > 0, [formData.applicants]);
  
  // New Logic: Unconfirmed Evidences
  const unconfirmedEvidences = useMemo(() => (formData.evidences || []).filter(e => !e.confirmed), [formData.evidences]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const handleSelectCustomer = (c: Customer) => {
    setFormData(prev => ({ ...prev, customer: c.name, customerId: c.id, contactInfo: { name: c.name, phone: c.phone, email: c.email, inn: c.inn } }));
    setCustomerSearch(c.name);
    setShowCustomerDropdown(false);
  };

  const updateAsset = (idx: number, field: keyof AssetRequirement, value: any) => {
    const updated = [...(formData.assetRequirements || [])];
    if (field === 'contractorId') {
      const c = contractors.find(item => item.id === value);
      updated[idx] = { ...updated[idx], contractorId: value, contractorName: c ? c.name : 'Биржа' };
    } else {
      updated[idx] = { ...updated[idx], [field]: value };
    }
    setFormData({ ...formData, assetRequirements: updated });
  };

  const approveApplicant = (applicant: DriverAssignment, index: number) => {
    const updatedApplicants = [...(formData.applicants || [])];
    updatedApplicants.splice(index, 1);

    const updatedDriverDetails = [...(formData.driverDetails || []), { ...applicant, tripsConfirmed: true }]; // Mark driver as active
    const updatedAssignedDrivers = [...(formData.assignedDrivers || []), applicant.driverName];

    const updated = {
      ...formData,
      applicants: updatedApplicants,
      driverDetails: updatedDriverDetails,
      assignedDrivers: updatedAssignedDrivers,
      status: formData.status === OrderStatus.CONFIRMED_BY_CUSTOMER ? OrderStatus.IN_PROGRESS : formData.status
    };

    setFormData(updated);
    onSubmit(updated);
  };

  const rejectApplicant = (index: number) => {
    const updatedApplicants = [...(formData.applicants || [])];
    updatedApplicants.splice(index, 1);
    setFormData({ ...formData, applicants: updatedApplicants });
  };

  const confirmTripEvidence = (evidenceId: string) => {
    const updatedEvidences = (formData.evidences || []).map(e => 
      e.id === evidenceId ? { ...e, confirmed: true } : e
    );
    // Recalculate actual trips
    const newActualTrips = updatedEvidences.filter(e => e.confirmed).length;
    
    const updated = {
      ...formData,
      evidences: updatedEvidences,
      actualTrips: newActualTrips
    };
    setFormData(updated);
    onSubmit(updated);
  };

  const smartAction = (action: 'quote' | 'direct' | 'exchange' | 'status', newStatus?: OrderStatus) => {
    let updated = { ...formData };
    
    if (action === 'quote') {
      updated.status = OrderStatus.AWAITING_CUSTOMER;
    } else if (action === 'direct') {
      updated.isBirzhaOpen = true; 
      alert("Персональные уведомления направлены подрядчикам!");
    } else if (action === 'exchange') {
      updated.isBirzhaOpen = true;
    } else if (action === 'status' && newStatus) {
      updated.status = newStatus;
      if (newStatus === OrderStatus.CONFIRMED_BY_CUSTOMER) updated.isFrozen = true;
    }

    setFormData(updated);
    onSubmit(updated);
  };

  return (
    <div className="bg-[#0a0f1d] p-8 rounded-[3rem] shadow-2xl border border-white/5 max-w-6xl mx-auto max-h-[95vh] overflow-y-auto font-['Inter'] text-white no-scrollbar">
      {/* 1. HEADER & STATUS STEPPER */}
      <div className="flex justify-between items-center mb-10 border-b border-white/5 pb-8">
        <div>
          <h2 className="text-4xl font-black uppercase tracking-tighter leading-none">{initialData ? 'Карточка объекта' : 'Новый объект'}</h2>
          <div className="flex items-center gap-3 mt-4">
             <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest bg-blue-500/10 px-3 py-1 rounded-lg">Менеджер: {formData.managerName}</span>
             {formData.isBirzhaOpen && <span className="text-[10px] font-black text-green-400 uppercase tracking-widest bg-green-500/10 px-3 py-1 rounded-lg animate-pulse">● Биржа активна</span>}
          </div>
        </div>
        <button onClick={onCancel} className="text-white/20 hover:text-white text-4xl">×</button>
      </div>

      {/* 2. PROGRESS STEPPER */}
      <div className="flex justify-between mb-12 px-4 relative">
        <div className="absolute top-1/2 left-0 right-0 h-1 bg-white/5 -translate-y-1/2 z-0"></div>
        {[OrderStatus.SENT, OrderStatus.AWAITING_CUSTOMER, OrderStatus.CONFIRMED_BY_CUSTOMER, OrderStatus.IN_PROGRESS, OrderStatus.COMPLETED].map((s, i) => {
          const isActive = formData.status === s;
          const isDone = Object.values(OrderStatus).indexOf(formData.status as any) > Object.values(OrderStatus).indexOf(s as any);
          return (
            <div key={s} className="relative z-10 flex flex-col items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-black border-4 ${isActive ? 'bg-blue-600 border-blue-400 shadow-[0_0_20px_rgba(37,99,235,0.5)]' : isDone ? 'bg-green-500 border-green-800' : 'bg-[#12192c] border-white/5 text-slate-600'}`}>
                {isDone ? '✓' : i + 1}
              </div>
              <span className={`text-[8px] font-black uppercase tracking-widest ${isActive ? 'text-white' : 'text-slate-600'}`}>{s}</span>
            </div>
          );
        })}
      </div>

      {/* 3. NEW: UNCONFIRMED TRIPS SECTION */}
      {unconfirmedEvidences.length > 0 && (
        <div className="mb-10 bg-orange-600/10 border-2 border-orange-500/40 rounded-[2.5rem] p-8 shadow-[0_0_40px_rgba(249,115,22,0.1)]">
           <h3 className="text-xs font-black uppercase tracking-[0.2em] text-orange-400 mb-6 flex items-center gap-3">
              <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
              📷 ФОТОКОНТРОЛЬ: Новые рейсы ({unconfirmedEvidences.length})
           </h3>
           <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {unconfirmedEvidences.map((ev) => (
                <div key={ev.id} className="group relative bg-black/40 rounded-2xl overflow-hidden border border-white/10 shadow-lg">
                   <img src={ev.photo} className="w-full h-40 object-cover opacity-80 group-hover:opacity-100 transition-all" />
                   <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black to-transparent">
                      <p className="text-[9px] font-black text-white uppercase mb-2 truncate">{ev.driverName}</p>
                      <button 
                        type="button" 
                        onClick={() => confirmTripEvidence(ev.id)} 
                        className="w-full bg-green-600 hover:bg-green-500 text-white py-2 rounded-lg text-[8px] font-black uppercase tracking-widest shadow-lg border-b-2 border-green-800 active:border-b-0 active:translate-y-[2px] transition-all"
                      >
                        ✅ Засчитать
                      </button>
                   </div>
                   <div className="absolute top-2 right-2 bg-orange-500 text-white text-[8px] font-black px-2 py-1 rounded-md uppercase shadow-md">
                      На проверке
                   </div>
                </div>
              ))}
           </div>
        </div>
      )}

      {/* 4. APPLICANTS SECTION */}
      {hasApplicants && (
        <div className="mb-10 bg-blue-600/10 border-2 border-blue-500/40 rounded-[2.5rem] p-8 shadow-[0_0_40px_rgba(37,99,235,0.1)]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-blue-400 flex items-center gap-3">
              <span className="w-2 h-2 bg-blue-400 rounded-full animate-ping"></span>
              📋 Новые отклики от водителей
            </h3>
            <span className="text-[10px] font-black bg-blue-500 text-white px-3 py-1 rounded-full">{formData.applicants?.length} КАНДИДАТОВ</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {formData.applicants?.map((app, idx) => (
              <div key={idx} className="bg-[#12192c] p-6 rounded-2xl border border-white/10 flex items-center justify-between group hover:border-blue-500/50 transition-all">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center text-2xl">
                    {app.assetType === AssetType.LOADER ? '🚜' : '🚛'}
                  </div>
                  <div>
                    <div className="text-sm font-black uppercase tracking-tight">{app.driverName}</div>
                    <div className="text-[8px] font-black text-blue-400 uppercase tracking-widest mt-1">Ставка: {app.acceptedPrice?.toLocaleString()} ₽</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => rejectApplicant(idx)} className="p-3 text-red-500 hover:bg-red-500/10 rounded-xl transition-all">✕</button>
                  <button type="button" onClick={() => approveApplicant(app, idx)} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest shadow-lg border-b-4 border-blue-800 active:translate-y-1 active:border-b-0 transition-all">Утвердить</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. SMART ACTION HUB */}
      <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/10 mb-10 shadow-2xl flex flex-wrap gap-4 items-center justify-between">
         <div className="flex flex-col">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Рекомендуемое действие:</span>
            <span className="text-sm font-bold text-blue-400">
               {formData.status === OrderStatus.SENT ? 'Подготовьте цены и отправьте клиенту' : 
                formData.status === OrderStatus.AWAITING_CUSTOMER ? 'Ожидание решения клиента или ручное подтверждение' :
                hasApplicants ? 'Утвердите прибывших водителей' : 
                unconfirmedEvidences.length > 0 ? 'Проверьте фотоотчеты водителей' : 'Контроль выполнения работ'}
            </span>
         </div>
         <div className="flex gap-3">
            {!isApprovedByCustomer && (
              <button type="button" onClick={() => smartAction('quote')} className="bg-blue-600 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-500 shadow-xl border-b-4 border-blue-800">
                🔔 Отправить КП клиенту
              </button>
            )}
            {hasDirectOffers && !formData.isBirzhaOpen && (
               <button type="button" onClick={() => smartAction('direct')} className="bg-orange-600 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-orange-500 shadow-xl border-b-4 border-orange-800">
                 📨 Персональные офферы
               </button>
            )}
            {hasBirzhaSlots && !formData.isBirzhaOpen && (
               <button type="button" onClick={() => smartAction('exchange')} className="bg-slate-700 px-6 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-600 shadow-xl border-b-4 border-slate-900">
                 🚀 Открыть биржу
               </button>
            )}
         </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* CUSTOMER & ADDRESS */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
           <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/5 relative" ref={dropdownRef}>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 block">Заказчик</label>
              <input 
                type="text" 
                className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm font-black outline-none focus:border-blue-500"
                value={customerSearch}
                onChange={e => {setCustomerSearch(e.target.value); setShowCustomerDropdown(true);}}
                onFocus={() => setShowCustomerDropdown(true)}
              />
              {showCustomerDropdown && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-[#1c2641] border border-white/10 rounded-2xl shadow-2xl z-50 max-h-48 overflow-y-auto no-scrollbar">
                  {customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase())).map(c => (
                    <div key={c.id} onClick={() => handleSelectCustomer(c)} className="p-4 hover:bg-blue-600 cursor-pointer text-xs font-black uppercase border-b border-white/5">{c.name}</div>
                  ))}
                </div>
              )}
           </div>
           <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/5">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 block">Адрес объекта</label>
              <input 
                type="text" 
                className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm font-black outline-none focus:border-blue-500"
                value={formData.address}
                onChange={e => setFormData({...formData, address: e.target.value})}
              />
           </div>
        </div>

        {/* ASSETS & PRICING */}
        <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/5">
           <div className="flex justify-between items-center mb-8">
              <h3 className="text-xs font-black uppercase tracking-widest">🚛 Техника и Экономика</h3>
              <div className="flex gap-2">
                 <button type="button" onClick={() => setFormData({...formData, assetRequirements: [...(formData.assetRequirements || []), { type: AssetType.TRUCK, contractorId: '', contractorName: 'Биржа', plannedUnits: 1 }]})} className="text-[9px] font-black bg-white/5 px-4 py-2 rounded-xl border border-white/10 hover:bg-blue-600 transition-all">+ Самосвал</button>
                 <button type="button" onClick={() => setFormData({...formData, assetRequirements: [...(formData.assetRequirements || []), { type: AssetType.LOADER, contractorId: '', contractorName: 'Биржа', plannedUnits: 1 }]})} className="text-[9px] font-black bg-white/5 px-4 py-2 rounded-xl border border-white/10 hover:bg-orange-600 transition-all">+ Погрузчик</button>
              </div>
           </div>
           
           <div className="space-y-4">
              {formData.assetRequirements?.map((req, idx) => (
                <div key={idx} className={`grid grid-cols-1 lg:grid-cols-5 gap-4 items-center bg-white/5 p-4 rounded-2xl border ${req.contractorId ? 'border-orange-500/30' : 'border-white/10'}`}>
                   <div className="flex items-center gap-3">
                      <span className="text-xl">{req.type === AssetType.LOADER ? '🚜' : '🚛'}</span>
                      <select className="bg-transparent text-[10px] font-black uppercase outline-none text-blue-400" value={req.contractorId} onChange={e => updateAsset(idx, 'contractorId', e.target.value)}>
                        <option value="" className="bg-[#12192c]">Биржа</option>
                        {contractors.map(c => <option key={c.id} value={c.id} className="bg-[#12192c]">{c.name}</option>)}
                      </select>
                   </div>
                   <div className="flex flex-col">
                      <span className="text-[7px] font-black text-slate-500 uppercase">Цена Клиенту</span>
                      <input type="number" className="bg-transparent border-b border-white/10 text-sm font-black p-1" value={req.customerPrice || ''} onChange={e => updateAsset(idx, 'customerPrice', parseInt(e.target.value))} />
                   </div>
                   <div className="flex flex-col">
                      <span className="text-[7px] font-black text-slate-500 uppercase">Цена Водителю</span>
                      <input type="number" className="bg-transparent border-b border-white/10 text-sm font-black p-1 text-green-400" value={req.birzhaPrice || ''} onChange={e => updateAsset(idx, 'birzhaPrice', parseInt(e.target.value))} />
                   </div>
                   <div className="flex flex-col">
                      <span className="text-[7px] font-black text-slate-500 uppercase">Кол-во ед.</span>
                      <input type="number" className="bg-transparent border-b border-white/10 text-sm font-black p-1" value={req.plannedUnits} onChange={e => updateAsset(idx, 'plannedUnits', parseInt(e.target.value))} />
                   </div>
                   <button type="button" onClick={() => {const up = [...formData.assetRequirements!]; up.splice(idx,1); setFormData({...formData, assetRequirements: up})}} className="text-red-500 text-[10px] font-black uppercase hover:underline">Удалить ×</button>
                </div>
              ))}
           </div>
        </div>

        {/* LOGISTICS */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
           <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/5">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 block">План рейсов</label>
              <input type="number" className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-4xl font-black outline-none focus:border-blue-500" value={formData.plannedTrips} onChange={e => setFormData({...formData, plannedTrips: parseInt(e.target.value)})} />
           </div>
           <div className="bg-[#12192c] p-8 rounded-[2.5rem] border border-white/5">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 block">Дата/Время начала</label>
              <input type="datetime-local" className="w-full bg-[#0a0f1d] border border-white/10 rounded-2xl p-5 text-sm font-black outline-none focus:border-blue-500" value={formData.scheduledTime} onChange={e => setFormData({...formData, scheduledTime: e.target.value})} />
           </div>
        </div>

        {/* FOOTER ACTIONS */}
        <div className="flex justify-between items-center pt-10 border-t border-white/5">
           <button type="button" onClick={onCancel} className="text-[10px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-all">Отмена</button>
           <div className="flex gap-4">
              <select 
                className="bg-[#12192c] text-[10px] font-black uppercase px-6 py-4 rounded-2xl border border-white/10 outline-none"
                value={formData.status}
                onChange={e => smartAction('status', e.target.value as OrderStatus)}
              >
                {Object.values(OrderStatus).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="submit" className="bg-white text-slate-900 px-16 py-4 rounded-2xl text-[12px] font-black uppercase tracking-widest shadow-2xl border-b-[6px] border-slate-200 active:translate-y-1 active:border-b-0 transition-all">
                {initialData ? 'Сохранить изменения' : 'Создать объект'}
              </button>
           </div>
        </div>
      </form>
    </div>
  );
};

export default OrderForm;
