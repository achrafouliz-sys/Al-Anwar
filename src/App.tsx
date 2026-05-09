import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Coordinates, 
  CalculationMethod, 
  PrayerTimes, 
  Qibla,
  Prayer 
} from 'adhan';
import { format, differenceInSeconds } from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MapPin, 
  Sunrise, 
  Sun, 
  Sunset, 
  Moon, 
  RefreshCw,
  Search,
  Info,
  Settings,
  WifiOff
} from 'lucide-react';
import { cn } from './lib/utils';
import { GoogleGenAI } from "@google/genai";
import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

const PRAYER_NAMES: Record<string, { label: string; icon: React.ReactNode }> = {
  fajr: { label: 'Fajr', icon: <Sunrise className="w-5 h-5" /> },
  sunrise: { label: 'Lever', icon: <Sun className="w-5 h-5 opacity-50" /> },
  dhuhr: { label: 'Dhuhr', icon: <Sun className="w-5 h-5" /> },
  asr: { label: 'Asr', icon: <Sun className="w-5 h-5 opacity-70" /> },
  maghrib: { label: 'Maghrib', icon: <Sunset className="w-5 h-5" /> },
  isha: { label: 'Isha', icon: <Moon className="w-5 h-5" /> },
};

const PRAYER_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

export default function App() {
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [cityLabel, setCityLabel] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [verse, setVerse] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'times' | 'qibla' | 'douas' | 'settings'>('times');
  const [calculationMethod, setCalculationMethod] = useState('MuslimWorldLeague');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLeadTime, setNotificationLeadTime] = useState(10); // minutes before
  const [theme, setTheme] = useState('midnight');
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    // Setup Capacitor plugins
    const initCapacitor = async () => {
      try {
        await StatusBar.hide(); // Fullscreen requirement
      } catch (e) {
        // Not on native device, ignore
      }
      
      try {
        await SplashScreen.hide();
      } catch (e) {
        // Not on native device
      }

      Network.addListener('networkStatusChange', status => {
        setIsOffline(!status.connected);
      });

      const checkStatus = await Network.getStatus();
      setIsOffline(!checkStatus.connected);

      // Handle back button for Android
      CapacitorApp.addListener('backButton', ({canGoBack}) => {
        if (activeTab !== 'times') {
          setActiveTab('times');
        } else {
          CapacitorApp.exitApp();
        }
      });
    };

    initCapacitor();
    
    return () => {
      Network.removeAllListeners();
      CapacitorApp.removeAllListeners();
    };
  }, [activeTab]);

  useEffect(() => {
    const savedMethod = localStorage.getItem('adhan-method');
    if (savedMethod) setCalculationMethod(savedMethod);

    const savedNotifs = localStorage.getItem('adhan-notifications');
    if (savedNotifs) setNotificationsEnabled(JSON.parse(savedNotifs));

    const savedLeadTime = localStorage.getItem('adhan-lead-time');
    if (savedLeadTime) setNotificationLeadTime(parseInt(savedLeadTime));

    const savedTheme = localStorage.getItem('adhan-theme');
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    const savedCoords = localStorage.getItem('adhan-coords');
    const savedLabel = localStorage.getItem('adhan-city-label');
    if (savedCoords && savedLabel) {
      setCoords(JSON.parse(savedCoords));
      setCityLabel(savedLabel);
    } else {
      const defaultCoords = { latitude: 48.8566, longitude: 2.3522 };
      setCoords(defaultCoords);
      setCityLabel("Paris");
      localStorage.setItem('adhan-coords', JSON.stringify(defaultCoords));
      localStorage.setItem('adhan-city-label', "Paris");
    }
  }, []);

  const searchCity = async (query: string) => {
    if (query.length < 3) return;
    setIsSearching(true);
    try {
      const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
      const data = await resp.json();
      setSearchResults(data);
    } catch (e) {
      console.error("Search error", e);
    } finally {
      setIsSearching(false);
    }
  };

  const selectCity = (result: any) => {
    const newCoords = { latitude: parseFloat(result.lat), longitude: parseFloat(result.lon) };
    const label = result.display_name.split(',')[0] + ', ' + result.display_name.split(',').slice(-1)[0];
    
    setCoords(newCoords);
    setCityLabel(label);
    localStorage.setItem('adhan-coords', JSON.stringify(newCoords));
    localStorage.setItem('adhan-city-label', label);
    setSearchResults([]);
    setSearchQuery('');
    setActiveTab('times');
  };
  const [isSensorActive, setIsSensorActive] = useState(false);
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  const prayerTimes = useMemo(() => {
    if (!coords) return null;
    const date = new Date();
    const coordinates = new Coordinates(coords.latitude, coords.longitude);
    const params = (CalculationMethod as any)[calculationMethod]();
    return new PrayerTimes(coordinates, date, params);
  }, [coords, currentTime.getDate(), calculationMethod]);

  const qiblaDirection = useMemo(() => {
    if (!coords) return 0;
    return Qibla(new Coordinates(coords.latitude, coords.longitude));
  }, [coords]);

  const nextPrayerKey = useMemo(() => {
    if (!prayerTimes) return null;
    const current = prayerTimes.nextPrayer();
    return current === 'none' ? 'fajr' : current;
  }, [prayerTimes, currentTime]);

  const timeLeft = useMemo(() => {
    if (!prayerTimes || !coords) return null;
    let nextTime = prayerTimes.timeForPrayer(prayerTimes.nextPrayer() as any);
    
    if (!nextTime || prayerTimes.nextPrayer() === 'none') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowPrayerTimes = new PrayerTimes(
        new Coordinates(coords.latitude, coords.longitude),
        tomorrow,
        CalculationMethod.MuslimWorldLeague()
      );
      nextTime = tomorrowPrayerTimes.fajr;
    }

    const diff = Math.max(0, differenceInSeconds(nextTime, currentTime));
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;

    return {
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0')
    };
  }, [prayerTimes, currentTime, coords]);

  const DOUAS = [
    { title: "Invocation du matin", arabic: "اللَّهُمَّ بِكَ أَصْبَحْنَا، وَبِكَ أَمْسَيْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ وَإِلَيْكَ النُّشُورُ" },
    { title: "Invocation du soir", arabic: "أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ، لَا إِلَهَ إِلَّا اللهُ وَحْدَهُ لَا شَرِيكَ لَهُ" },
    { title: "En sortant de la maison", arabic: "بِسْمِ اللَّهِ، تَوَكَّلْتُ عَلَى اللَّهِ، وَلَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللَّهِ" },
    { title: "Pour la protection", arabic: "بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ وَهُوَ السَّمِيعُ الْعَلِيمُ" }
  ];

  // Update time every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Handle device orientation for real-time compass
  useEffect(() => {
    if (!isSensorActive || activeTab !== 'qibla') return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      // @ts-ignore - webkitCompassHeading is a non-standard property for iOS
      let heading = e.webkitCompassHeading;
      
      // If we are on Android or standard absolute orientation is available
      if (heading === undefined && e.alpha !== null) {
        // alpha is 0 when the device is pointed north, and increases counter-clockwise
        heading = (360 - e.alpha) % 360;
      }

      if (heading !== null && heading !== undefined) {
        setDeviceHeading(heading); 
      }
    };

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const eventName = isIOS ? 'deviceorientation' : 'deviceorientationabsolute';
    
    window.addEventListener(eventName, handleOrientation as any, true);
    if (!isIOS) {
        window.addEventListener('deviceorientation', handleOrientation as any, true);
    }

    return () => {
        window.removeEventListener(eventName, handleOrientation as any, true);
        window.removeEventListener('deviceorientation', handleOrientation as any, true);
    };
  }, [activeTab, isSensorActive]);

  const requestCompassPermission = async () => {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        // @ts-ignore
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        // @ts-ignore
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          setIsSensorActive(true);
        }
      } catch (e) {
        console.error("Permission request failed", e);
        setError("L'accès aux capteurs de mouvement a été refusé.");
      }
    } else {
      setIsSensorActive(true);
    }
  };

  const saveMethod = (method: string) => {
    setCalculationMethod(method);
    localStorage.setItem('adhan-method', method);
  };

  const toggleNotifications = async () => {
    if (!notificationsEnabled) {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          setNotificationsEnabled(true);
          localStorage.setItem('adhan-notifications', 'true');
          new Notification("Nour", { body: "Les notifications sont activées !" });
        } else {
          alert("Permission de notification refusée.");
        }
      }
    } else {
      setNotificationsEnabled(false);
      localStorage.setItem('adhan-notifications', 'false');
    }
  };

  const updateLeadTime = (time: number) => {
    setNotificationLeadTime(time);
    localStorage.setItem('adhan-lead-time', String(time));
  };

  // Notification Check Logic
  const notifiedPrayers = useRef<Set<string>>(new Set());
  
  useEffect(() => {
    if (!notificationsEnabled || !prayerTimes) return;

    const checkInterval = setInterval(() => {
      const now = new Date();
      
      // Reset daily notified prayers if it's a new day (after midnight)
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        notifiedPrayers.current.clear();
      }

      PRAYER_ORDER.forEach(key => {
        const time = prayerTimes.timeForPrayer(key as any);
        if (time) {
          const notificationTime = new Date(time.getTime() - notificationLeadTime * 60000);
          
          // Check if it's time to notify (within current minute) and not yet notified
          if (now.getHours() === notificationTime.getHours() && 
              now.getMinutes() === notificationTime.getMinutes() &&
              !notifiedPrayers.current.has(key)) {
            
            notifiedPrayers.current.add(key);
            
            new Notification("Avertissement de prière", {
              body: `La prière de ${PRAYER_NAMES[key as keyof typeof PRAYER_NAMES].label} sera dans ${notificationLeadTime} minutes.`,
              icon: "https://picsum.photos/seed/nour-icon-192/192/192"
            });
          }
        }
      });
    }, 1000);

    return () => clearInterval(checkInterval);
  }, [notificationsEnabled, prayerTimes, notificationLeadTime]);

  const changeTheme = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem('adhan-theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const CALC_METHODS = [
    { id: 'MuslimWorldLeague', label: 'Ligue Islamique Mondiale' },
    { id: 'UmmAlQura', label: 'Umm Al-Qura (La Mecque)' },
    { id: 'Egyptian', label: 'Autorité Égyptienne' },
    { id: 'NorthAmerica', label: 'ISNA (Amérique du Nord)' },
    { id: 'Dubai', label: 'Dubaï' },
    { id: 'Kuwait', label: 'Koweït' },
    { id: 'Turkey', label: 'Turquie' },
  ];

  const fetchVerse = async () => {
    try {
      setVerse(null);
      const apiKey = process.env.GEMINI_API_KEY || '';
      if (!apiKey) return;
      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        model: "gemini-flash-latest",
        contents: "Donne moi un court verset du Coran inspirant. Réponds UNIQUEMENT avec un objet JSON contenant: { \"arabic\": \"le texte en arabe\", \"ref\": \"la référence\" }",
      });
      const text = result.text || '';
      const cleanJson = text.replace(/```json|```/g, '');
      setVerse(cleanJson);
    } catch (e) {
      console.error("Gemini Error:", e);
    }
  };

  useEffect(() => {
    fetchVerse();
  }, []);

  const handleRefresh = () => {
    setCurrentTime(new Date());
    fetchVerse();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-transparent text-foreground">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}>
          <RefreshCw className="w-8 h-8 text-accent opacity-50" />
        </motion.div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen p-10 flex flex-col items-center justify-center bg-transparent text-foreground text-center">
        <Info className="w-12 h-12 text-accent mb-6 opacity-30" />
        <h2 className="text-3xl font-serif font-light mb-2">Un instant</h2>
        <p className="opacity-60 mb-8 text-sm tracking-wide">{error}</p>
        <button onClick={() => setActiveTab('settings')} className="px-8 py-3 border border-border-strong text-accent text-[9px] tracking-[0.3em] font-medium uppercase hover:bg-surface-hover transition-all rounded-full">
          Aller aux paramètres
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-transparent text-foreground font-sans overflow-hidden">
      <header className="px-6 md:px-12 py-6 flex justify-between items-center shrink-0 border-b border-border-light bg-base/30 backdrop-blur-md z-10">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-full border border-accent flex items-center justify-center text-accent font-serif italic text-sm">A</div>
          <span className="font-serif tracking-wide text-lg">Al-Anwar</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 opacity-60">
            <MapPin className="w-3.5 h-3.5 text-accent" />
            <span className="text-[9px] tracking-[0.2em] font-medium uppercase text-foreground">
              {cityLabel || 'Ville non définie'}
            </span>
          </div>
          <button 
            onClick={handleRefresh}
            className="p-2 opacity-60 hover:opacity-100 hover:bg-surface-hover rounded-full transition-all"
            title="Rafraîchir"
          >
            <RefreshCw className="w-4 h-4 text-accent" />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full h-full overflow-y-auto overflow-x-hidden scrollbar-hide py-4 md:py-8 flex flex-col items-center">
        <AnimatePresence>
          {isOffline && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="w-full max-w-sm mx-auto mb-6 px-4 py-3 bg-red-900/30 border border-red-500/30 rounded-2xl flex items-center justify-center space-x-3 text-red-200"
            >
              <WifiOff className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">Vous êtes hors ligne. Certaines fonctionnalités peuvent être indisponibles.</p>
            </motion.div>
          )}
        </AnimatePresence>

        {deferredPrompt && activeTab === 'times' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6 px-6 py-3 bg-surface border border-accent/30 backdrop-blur-md rounded-full flex items-center justify-between space-x-6 max-w-sm"
          >
            <span className="text-[10px] font-medium text-foreground uppercase tracking-widest">Installer l'app offline</span>
            <button 
              onClick={handleInstallClick}
              className="px-4 py-1.5 bg-accent text-inverted text-[9px] font-medium uppercase tracking-[0.2em] rounded-full hover:scale-105 transition-transform"
            >
              Obtenir
            </button>
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          {activeTab === 'times' ? (
            <motion.div 
              key="times"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full flex-1 flex flex-col"
            >
              <div className="flex-1 flex flex-col items-center justify-center py-10 min-h-[40vh]">
                <span className="text-[10px] tracking-[0.4em] uppercase text-accent mb-6 font-medium">Temps restant</span>
                <span className="text-[5rem] md:text-[8rem] leading-none font-sans font-light tracking-tighter tabular-nums text-foreground drop-shadow-sm">
                  {timeLeft?.hours}:{timeLeft?.minutes}:{timeLeft?.seconds}
                </span>
                <div className="mt-8 flex flex-col items-center">
                  <span className="text-[9px] uppercase tracking-[0.3em] opacity-40 mb-2">Prochaine prière</span>
                  <h2 className="text-4xl md:text-5xl font-serif text-accent capitalize font-light">
                    {nextPrayerKey ? PRAYER_NAMES[nextPrayerKey].label : '---'}
                  </h2>
                </div>
              </div>

              <div className="pb-12 px-6 md:px-12 max-w-6xl w-full mx-auto">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 md:gap-4">
                  {PRAYER_ORDER.map((key) => {
                    const isNext = key === nextPrayerKey;
                    const time = prayerTimes?.[key as any];
                    return (
                      <div 
                        key={key} 
                        className={cn(
                          "relative p-5 md:p-6 rounded-[20px] flex flex-col justify-between overflow-hidden transition-all duration-500",
                          isNext 
                            ? "bg-accent text-inverted shadow-[0_8px_30px_rgb(0,0,0,0.12)] scale-[1.02] md:scale-105 z-10" 
                            : "bg-surface border border-border-light hover:border-border-strong hover:bg-surface-hover"
                        )}
                      >
                        <span className={cn(
                          "text-[9px] tracking-[0.2em] font-medium uppercase mb-4 md:mb-6 leading-none",
                          isNext ? "text-inverted opacity-80" : "opacity-50"
                        )}>
                          {PRAYER_NAMES[key].label}
                        </span>
                        <span className={cn(
                          "text-3xl md:text-4xl font-serif font-light leading-none",
                          isNext ? "text-inverted" : "text-foreground"
                        )}>
                          {time instanceof Date ? format(time, 'HH:mm') : '--:--'}
                        </span>
                        {isNext && (
                          <div className="absolute top-0 right-0 w-24 h-24 bg-white/20 blur-2xl rounded-full -mr-8 -mt-8" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {verse && (
                <div className="px-6 md:px-12 max-w-4xl mx-auto w-full pb-10">
                  <div className="text-center p-8 md:p-12 bg-surface/50 border border-border-light rounded-[32px] backdrop-blur-md">
                    {(() => {
                      try {
                        const v = JSON.parse(verse);
                        return (
                          <>
                            <p className="font-amiri text-3xl md:text-4xl text-foreground mb-6 leading-relaxed font-light">{v.arabic}</p>
                            <p className="text-[9px] font-medium uppercase tracking-[0.2em] opacity-40 mt-6">{v.ref}</p>
                          </>
                        );
                      } catch (e) {
                        return <p className="italic opacity-60 text-sm">{verse.replace(/\"|verse:|verse/gi, '').trim()}</p>;
                      }
                    })()}
                  </div>
                </div>
              )}
            </motion.div>
          ) : activeTab === 'qibla' ? (
            <motion.div 
              key="qibla"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex-1 flex flex-col items-center justify-center py-6"
            >
              <div className="relative w-72 h-72 md:w-96 md:h-96 border border-border-light rounded-full flex items-center justify-center backdrop-blur-md bg-surface">
                <div className="absolute w-[92%] h-[92%] border border-border-light rounded-full" />
                <div className="absolute w-[65%] h-[65%] border border-border-strong rounded-full" />
                
                {/* Compass Rose (Rotating with device) */}
                <motion.div 
                  className="absolute inset-0 flex items-center justify-center"
                  animate={{ rotate: -(deviceHeading || 0) }}
                  transition={{ type: 'spring', stiffness: 30, damping: 10 }}
                >
                  {[0, 90, 180, 270].map((deg) => (
                    <span 
                      key={deg} 
                      className={cn(
                        "absolute text-[10px] font-medium tracking-[0.2em] transition-colors duration-500",
                        deg === 0 ? "text-accent" : "opacity-40"
                      )}
                      style={{ 
                        transform: `rotate(${deg}deg) translateY(-170px)` 
                      }}
                    >
                      {deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : 'W'}
                    </span>
                  ))}

                  {/* Dial Ticks */}
                  {[...Array(72)].map((_, i) => (
                    <div 
                      key={i}
                      className="absolute w-[1px] h-[6px] bg-border-light"
                      style={{ transform: `rotate(${i * 5}deg) translateY(-155px)` }}
                    />
                  ))}
                </motion.div>

                <motion.div 
                  className="relative w-full h-full flex items-center justify-center"
                  animate={{ rotate: qiblaDirection - (deviceHeading || 0) }}
                  transition={{ type: 'spring', stiffness: 30, damping: 10 }}
                >
                  <motion.div 
                    className="absolute w-[1px] h-48 bg-gradient-to-t from-transparent via-accent to-transparent"
                    animate={{ 
                      opacity: [0.6, 1, 0.6],
                      scaleY: [0.95, 1, 0.95]
                    }}
                    transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                  />
                  <div className="w-6 h-6 bg-base border border-accent/50 rounded-full z-10 flex items-center justify-center shadow-[0_0_15px_rgba(229,193,88,0.2)]">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                  </div>
                </motion.div>

                <div className="absolute text-center mt-56 bg-base/60 backdrop-blur-xl px-6 py-2 rounded-full border border-border-light">
                  <span className="text-[9px] tracking-[0.2em] uppercase opacity-50 block mb-[2px]">Direction</span>
                  <span className="text-xl font-serif font-light">{qiblaDirection.toFixed(1)}°</span>
                </div>
              </div>
              <p className="mt-14 opacity-40 text-[9px] uppercase tracking-[0.2em] text-center max-w-[240px] leading-relaxed">
                Tournez votre appareil pour aligner la ligne vers le haut.
              </p>
              {!isSensorActive && (
                <button 
                  onClick={requestCompassPermission}
                  className="mt-10 px-8 py-3 bg-surface text-accent border border-border-strong text-[9px] font-medium tracking-[0.2em] uppercase rounded-full hover:bg-surface-hover hover:text-foreground transition-all"
                >
                  Activer la boussole
                </button>
              )}
            </motion.div>
          ) : activeTab === 'settings' ? (
            <motion.div 
              key="settings"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="flex-1 flex flex-col space-y-8 py-4"
            >
              <div>
                <h2 className="text-4xl md:text-5xl font-serif font-light tracking-tight mt-1 mb-2">Paramètres</h2>
                <p className="opacity-60 text-xs">Personnalisez votre expérience Al-Anwar.</p>
              </div>

              <div className="space-y-6">
                <div>
                  <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-4">Ville et Localisation</h3>
                  <div className="relative">
                    <div className="flex gap-2 mb-4">
                      <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 opacity-40" />
                        <input 
                          type="text"
                          placeholder="Rechercher une ville..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && searchCity(searchQuery)}
                          className="w-full bg-surface border border-border-light rounded-2xl py-4 pl-12 pr-6 text-sm text-foreground focus:border-accent/50 outline-none transition-all placeholder:opacity-30 backdrop-blur-md"
                        />
                      </div>
                      <button 
                        onClick={() => searchCity(searchQuery)}
                        className="px-6 rounded-2xl bg-surface border border-border-strong text-accent text-[10px] font-medium uppercase tracking-widest hover:bg-surface-hover transition-colors"
                      >
                        {isSearching ? <RefreshCw className="w-4 h-4 animate-spin mx-auto" /> : "Chercher"}
                      </button>
                    </div>

                    {searchResults.length > 0 && (
                      <div className="absolute z-50 w-full bg-base/95 backdrop-blur-xl border border-border-strong rounded-2xl mt-2 overflow-hidden shadow-2xl">
                        {searchResults.map((result, idx) => (
                          <button
                            key={idx}
                            onClick={() => selectCity(result)}
                            className="w-full px-6 py-4 text-left text-sm opacity-80 hover:bg-surface hover:opacity-100 transition-colors border-b border-border-light last:border-0"
                          >
                            {result.display_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-4">Thème</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { id: 'midnight', label: 'Minuit' },
                      { id: 'desert', label: 'Désert' },
                      { id: 'emerald', label: 'Émeraude' },
                      { id: 'pearl', label: 'Perle' }
                    ].map((t) => (
                      <button
                        key={t.id}
                        onClick={() => changeTheme(t.id)}
                        className={cn(
                          "w-full px-4 py-4 rounded-2xl text-center transition-all border backdrop-blur-md flex flex-col items-center justify-center space-y-2",
                          theme === t.id 
                            ? "bg-surface-hover border-border-strong text-foreground" 
                            : "bg-surface border-border-light opacity-60 hover:opacity-100 hover:border-border-strong"
                        )}
                      >
                        <span className="text-sm font-serif">{t.label}</span>
                        {theme === t.id && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-4">Méthode de calcul</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {CALC_METHODS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => saveMethod(m.id)}
                        className={cn(
                          "w-full px-6 py-4 rounded-2xl text-left transition-all border backdrop-blur-md",
                          calculationMethod === m.id 
                            ? "bg-surface-hover border-border-strong text-foreground" 
                            : "bg-surface border-border-light opacity-60 hover:opacity-100 hover:border-border-strong"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-serif">{m.label}</span>
                          {calculationMethod === m.id && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-6 md:p-8 bg-surface border border-border-light rounded-3xl backdrop-blur-md">
                  <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-6">Notifications</h3>
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <p className="text-sm text-foreground mb-1">Activer les rappels</p>
                      <p className="text-[10px] opacity-40">Avertir avant chaque prière</p>
                    </div>
                    <button 
                      onClick={toggleNotifications}
                      className={cn(
                        "w-12 h-6 rounded-full transition-all relative overflow-hidden",
                        notificationsEnabled ? "bg-accent" : "bg-surface-hover border border-border-light"
                      )}
                    >
                      <motion.div 
                        animate={{ x: notificationsEnabled ? 24 : 4 }}
                        className="absolute top-1 w-4 h-4 rounded-full bg-inverted shadow-sm" 
                      />
                    </button>
                  </div>

                  {notificationsEnabled && (
                    <div className="space-y-4 pt-6 border-t border-border-light">
                      <p className="text-[9px] text-accent uppercase tracking-widest">Rappel avant (minutes)</p>
                      <div className="flex gap-2">
                        {[5, 10, 15, 30].map(time => (
                          <button
                            key={time}
                            onClick={() => updateLeadTime(time)}
                            className={cn(
                              "flex-1 py-3 rounded-xl text-[10px] uppercase font-medium transition-all border tracking-widest",
                              notificationLeadTime === time 
                                ? "bg-accent text-inverted border-accent" 
                                : "bg-surface border-border-light opacity-60 hover:opacity-100"
                            )}
                          >
                            {time}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-6 md:p-8 bg-surface border border-border-light rounded-3xl backdrop-blur-md">
                  <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-3">À propos</h3>
                  <p className="opacity-60 text-xs leading-relaxed">
                    Al-Anwar est une application minimaliste conçue pour la sérénité.
                    Version 1.2 • Développé avec soin.
                  </p>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="douas"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="flex-1 flex flex-col space-y-6 py-4"
            >
              <h2 className="text-4xl font-serif font-light tracking-tight mt-1 mb-6">Douas</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {DOUAS.map((doa, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="p-8 bg-surface border border-border-light rounded-[32px] backdrop-blur-md"
                  >
                    <h3 className="text-[9px] tracking-[0.2em] uppercase text-accent mb-6">{doa.title}</h3>
                    <p className="font-amiri text-2xl text-right leading-relaxed mb-6 font-light" dir="rtl">{doa.arabic}</p>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="px-4 py-8 flex justify-center items-center pointer-events-none sticky bottom-0 w-full z-50 mt-auto">
        <div className="flex space-x-1 md:space-x-2 p-2 bg-surface/90 backdrop-blur-2xl border border-border-strong rounded-full shadow-2xl pointer-events-auto">
          <button 
            onClick={() => setActiveTab('times')}
            className={cn(
              "px-5 md:px-6 py-2.5 md:py-3 rounded-full text-[9px] md:text-[10px] tracking-[0.2em] font-medium uppercase transition-all",
              activeTab === 'times' ? "bg-accent text-inverted shadow-md" : "text-foreground opacity-60 hover:opacity-100 hover:bg-surface-hover"
            )}
          >
            Temps
          </button>
          <button 
            onClick={() => setActiveTab('qibla')}
            className={cn(
              "px-5 md:px-6 py-2.5 md:py-3 rounded-full text-[9px] md:text-[10px] tracking-[0.2em] font-medium uppercase transition-all",
              activeTab === 'qibla' ? "bg-accent text-inverted shadow-md" : "text-foreground opacity-60 hover:opacity-100 hover:bg-surface-hover"
            )}
          >
            Qibla
          </button>
          <button 
            onClick={() => setActiveTab('douas')}
            className={cn(
              "px-5 md:px-6 py-2.5 md:py-3 rounded-full text-[9px] md:text-[10px] tracking-[0.2em] font-medium uppercase transition-all",
              activeTab === 'douas' ? "bg-accent text-inverted shadow-md" : "text-foreground opacity-60 hover:opacity-100 hover:bg-surface-hover"
            )}
          >
            Douas
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={cn(
              "px-5 md:px-6 py-2.5 md:py-3 rounded-full flex items-center justify-center transition-all",
              activeTab === 'settings' ? "bg-accent text-inverted shadow-md" : "text-foreground opacity-60 hover:opacity-100 hover:bg-surface-hover"
            )}
          >
            <Settings className="w-4 h-4 md:w-4 md:h-4" />
          </button>
        </div>
      </footer>
    </div>
  );
}
