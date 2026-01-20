
import React, { useState, useMemo } from 'react';
import { Order, OrderStatus, TripEvidence, Contractor, AssetType } from '../types';

interface DriverPortalProps {
  orders: Order[];
  contractors: Contractor[];
  driverName: string; 
  driverContractorId: string;
  onReportTrip: (orderId: string, evidence: TripEvidence) => void;
  onAcceptJob: (orderId: string, contractorId: string, assetType: AssetType) => void;
  onFinishWork: (orderId: string) => void; 
}

const DriverPortal: React.FC<DriverPortalProps> = ({ 
  orders, 
  driverName, 
  driverContractorId,
  onReportTrip, 
  onAcceptJob, 
  onFinishWork 
}) => {
  const [selectedOrder, setSelectedOrder] = useState<{ order: Order; type: AssetType } | null>(null);
  const [activeTab, setActiveTab] = useState<'mine' | 'public' | 'company'>('mine');

  // Logic for displaying available jobs
  const myJobs = useMemo(() => orders.filter(o => 
    o.assignedDrivers.includes(driverName) && 
    o.status !== OrderStatus.CANCELLED
  ), [orders, driverName]);

  const publicBoard = useMemo(() => {
    const list: { order: Order; type: AssetType }[] = [];
    orders.forEach(o => {
      if (!o.isBirzhaOpen || o.status === OrderStatus.COMPLETED || o.status === OrderStatus.CANCELLED) return;
      o.assetRequirements.filter(req => !req.contractorId).forEach(req => {
        const assigned = o.driverDetails.filter(d => d.assetType === req.type && !d.contractorId).length;
        if (assigned < req.plannedUnits && !o.driverDetails.some(d => d.driverName === driverName && d.assetType === req.type)) {
          list.push({ order: o, type: req.type });
        }
      });
    });
    return list;
  }, [orders, driverName]);

  const companyBoard = useMemo(() => {
    const list: { order: Order; type: AssetType }[] = [];
    if (!driverContractorId) return list;
    orders.forEach(o => {
      if (!o.isBirzhaOpen || o.status === OrderStatus.COMPLETED) return;
      o.assetRequirements.filter(req => req.contractorId === driverContractorId).forEach(req => {
        const assigned = o.driverDetails.filter(d => d.assetType === req.type && d.contractorId === driverContractorId).length;
        if (assigned < req.plannedUnits && !o.driverDetails.some(d => d.driverName === driverName && d.assetType === req.type)) {
          list.push({ order: o, type: req.type });
        }
      });
    });
    return list;
  }, [orders, driverName, driverContractorId]);

  const displayJobs = activeTab === 'mine' ? myJobs.map(j => ({ order: j, type: j.driverDetails.find(d => d.driverName === driverName)?.assetType || AssetType.TRUCK })) :
                     activeTab === 'public' ? publicBoard : companyBoard;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedOrder || !e.target.files?.[0]) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      onReportTrip(selectedOrder.order.id, {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        photo: reader.result as string,
        driverName: driverName,
        confirmed: false
      });
      // Keep selected order updated
      // We need to wait a tick for the parent to update state usually, but here we just optimistically assume parent handles it.
      // However, selectedOrder is local state copy. Ideally we should find it from 'orders' prop.
      // We will re-find it in the render to ensure we have latest evidences.
    };
    reader.readAsDataURL(e.target.files[0]);
  };

  // Ensure we display the latest version of the selected order
  const activeSelectedOrder = selectedOrder 
    ? orders.find(o => o.id === selectedOrder.order.id) 
    : null;

  const driverEvidences = activeSelectedOrder 
    ? (activeSelectedOrder.evidences || []).filter(e => e.driverName === driverName)
    : [];

  const confirmedCount = driverEvidences.filter(e => e.confirmed).length;

  return (
    <div className="flex flex-col h-full bg-[#0a0f1d] text-white">
      {/* HEADER */}
      <div className="p-6 bg-[#12192c] border-b border-white/5 shadow-2xl sticky top-0 z-30">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center font-black">{driverName.charAt(0)}</div>
            <div>
              <h2 className="text-sm font-black uppercase truncate max-w-[150px]">{driverName}</h2>
              <p className="text-[8px] text-blue-400 font-bold uppercase tracking-widest">Личный кабинет водителя</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 bg-[#1c2641] p-1 rounded-xl border border-white/5 gap-1">
          <button onClick={() => { setActiveTab('mine'); setSelectedOrder(null); }} className={`py-3 text-[9px] font-black uppercase rounded-lg transition-all ${activeTab === 'mine' ? 'bg-white text-slate-900 shadow-xl' : 'text-slate-500'}`}>В работе</button>
          <button onClick={() => { setActiveTab('company'); setSelectedOrder(null); }} className={`py-3 text-[9px] font-black uppercase rounded-lg transition-all ${activeTab === 'company' ? 'bg-orange-500 text-white shadow-xl' : 'text-slate-500'}`}>Прямые</button>
          <button onClick={() => { setActiveTab('public'); setSelectedOrder(null); }} className={`py-3 text-[9px] font-black uppercase rounded-lg transition-all ${activeTab === 'public' ? 'bg-blue-600 text-white shadow-xl' : 'text-slate-500'}`}>Биржа</button>
        </div>
      </div>

      {/* CONTENT */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-40 no-scrollbar">
        {!activeSelectedOrder ? (
          displayJobs.length > 0 ? (
            displayJobs.map(({ order: job, type }, idx) => (
              <button key={idx} onClick={() => setSelectedOrder({ order: job, type })} className={`w-full text-left rounded-3xl border-2 bg-[#12192c] p-6 shadow-xl transition-all ${activeTab === 'company' ? 'border-orange-500/30' : 'border-white/5'}`}>
                 <div className="flex justify-between items-center mb-3">
                    <span className="text-[9px] font-black text-blue-400 uppercase tracking-widest">{job.customer}</span>
                    <span className="text-[8px] font-black uppercase bg-black/20 px-2 py-1 rounded-md">{job.status}</span>
                 </div>
                 <h4 className="text-xl font-black mb-4 leading-tight uppercase">{job.address}</h4>
                 <div className="flex justify-between items-end pt-4 border-t border-white/5">
                    <div className="text-2xl font-black text-green-400">
                       {(job.assetRequirements.find(r => r.type === type)?.birzhaPrice || 0).toLocaleString()} ₽
                    </div>
                    <span className="text-[9px] font-black uppercase text-slate-500">{type}</span>
                 </div>
              </button>
            ))
          ) : (
            <div className="text-center py-20 opacity-20 text-[10px] font-black uppercase tracking-[0.4em]">Записей нет</div>
          )
        ) : (
          <div className="bg-[#12192c] rounded-[2.5rem] p-8 border border-blue-500/30 shadow-2xl animate-in slide-in-from-bottom-8">
             <button onClick={() => setSelectedOrder(null)} className="mb-6 text-[9px] font-black uppercase text-slate-500">← Назад</button>
             <h3 className="text-3xl font-black mb-2 uppercase">{activeSelectedOrder.address}</h3>
             <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-8">{new Date(activeSelectedOrder.scheduledTime).toLocaleString('ru')}</p>
             
             <div className="bg-[#0a0f1d] p-6 rounded-2xl border border-white/5 mb-8 text-center flex justify-between items-center">
                <div className="text-left">
                  <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">Ставка</span>
                  <span className="text-2xl font-black text-white">{(activeSelectedOrder.assetRequirements.find(r => r.type === selectedOrder?.type)?.birzhaPrice || 0).toLocaleString()} ₽</span>
                </div>
                <div className="text-right">
                  <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">Засчитано</span>
                  <span className="text-2xl font-black text-green-400">{confirmedCount} р.</span>
                </div>
             </div>

             {activeSelectedOrder.assignedDrivers.includes(driverName) ? (
                <div className="space-y-4">
                   {selectedOrder?.type === AssetType.TRUCK ? (
                      <>
                        <label className="block w-full cursor-pointer">
                          <div className="bg-blue-600 p-12 rounded-3xl flex flex-col items-center gap-4 border-b-8 border-blue-800 shadow-2xl active:scale-95 transition-all">
                             <span className="text-6xl">📸</span>
                             <span className="font-black uppercase tracking-widest text-white">Отправить фото</span>
                          </div>
                          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
                        </label>
                        
                        {/* History List */}
                        {driverEvidences.length > 0 && (
                          <div className="mt-8">
                             <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4">История смены</h4>
                             <div className="space-y-2">
                                {driverEvidences.slice().reverse().map((ev, i) => (
                                   <div key={ev.id} className="flex items-center gap-4 bg-white/5 p-3 rounded-xl border border-white/5">
                                      <div className="w-12 h-12 bg-black rounded-lg overflow-hidden shrink-0">
                                        <img src={ev.photo} className="w-full h-full object-cover" />
                                      </div>
                                      <div className="flex-1">
                                         <div className="text-[10px] font-black uppercase text-slate-300">Рейс {new Date(ev.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                                         <div className={`text-[8px] font-bold uppercase tracking-widest ${ev.confirmed ? 'text-green-400' : 'text-orange-400'}`}>
                                            {ev.confirmed ? '✅ Принят' : '⏳ На проверке'}
                                         </div>
                                      </div>
                                   </div>
                                ))}
                             </div>
                          </div>
                        )}
                      </>
                   ) : (
                      <div className="bg-green-500/10 p-8 rounded-2xl text-center border border-green-500/20">
                         <span className="text-[10px] font-black uppercase text-green-400">Вы работаете (смена открыта)</span>
                      </div>
                   )}
                   <button onClick={() => { if(confirm('Закончить смену?')) { onFinishWork(activeSelectedOrder.id); setSelectedOrder(null); } }} className="w-full bg-slate-800 p-6 rounded-3xl text-[10px] font-black uppercase text-slate-400 mt-8">Завершить работу</button>
                </div>
             ) : (
                <button onClick={() => { onAcceptJob(activeSelectedOrder.id, driverContractorId, selectedOrder!.type); setSelectedOrder(null); }} className="w-full bg-blue-600 p-12 rounded-3xl text-3xl font-black uppercase tracking-widest border-b-8 border-blue-800 shadow-2xl">ПРИНЯТЬ ✅</button>
             )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DriverPortal; 
