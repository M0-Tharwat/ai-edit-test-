
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ToolMode, ManualFilters, DEFAULT_FILTERS, GalleryImage, Workspace, VideoClip, VideoTrack, AudioTrack } from './types';
import { 
  generateImageFromText, 
  removeBackground, 
  removeObject, 
  replaceBackground, 
  upscaleImage, 
  relightImage,
  runNanoBanana,
  analyzeImageForSuggestions,
  generateVideo,
  analyzeImage,
  analyzeVideoFrameForEditing
} from './services/geminiService';
import { Icons } from './components/Icon';

const MAX_IMAGES = 100;
const MAX_HISTORY_STACK = 10; // Limit history to prevent memory leaks
const HEADER_WIDTH = 120; // Fixed width for track headers

// High precision rounding to prevent gaps
const roundTime = (val: number) => Math.round(val * 10000) / 10000;

const FILTER_PRESETS: Record<string, string> = {
    none: '',
    grayscale: 'grayscale(100%)',
    sepia: 'sepia(100%)',
    vintage: 'sepia(50%) contrast(120%) brightness(90%)',
    cyberpunk: 'saturate(200%) hue-rotate(180deg) contrast(120%)',
    warm: 'sepia(30%) saturate(140%) hue-rotate(-10deg)',
    cool: 'hue-rotate(180deg) brightness(110%) saturate(80%)',
    drama: 'contrast(150%) saturate(0%) brightness(80%)'
};

// --- FADE CURVES ---
const calculateFadeFactor = (t: number, type: 'linear' | 'smooth' | 'buttery') => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    
    if (type === 'linear') return t;
    if (type === 'buttery') return t * t * t * (t * (t * 6 - 15) + 10);
    // Default Smooth
    return t * t * (3 - 2 * t);
};

interface AiChangeItem {
    key: keyof VideoClip;
    label: string;
    oldValue: any;
    newValue: any;
    selected: boolean;
}

// --- AUDIO ENGINE CLASS ---
// Handles the Web Audio API graph for the Audio Studio
class AudioGraph {
    ctx: AudioContext;
    sources: Map<string, MediaElementAudioSourceNode> = new Map();
    gains: Map<string, GainNode> = new Map();
    eqs: Map<string, { low: BiquadFilterNode, mid: BiquadFilterNode, high: BiquadFilterNode }> = new Map();
    pans: Map<string, StereoPannerNode> = new Map();
    masterGain: GainNode;

    constructor() {
        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
    }

    addTrack(id: string, element: HTMLAudioElement) {
        if (this.sources.has(id)) return;

        // Create Nodes
        const source = this.ctx.createMediaElementSource(element);
        const low = this.ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 320;
        const mid = this.ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.5;
        const high = this.ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3200;
        const pan = this.ctx.createStereoPanner();
        const gain = this.ctx.createGain();

        // Chain: Source -> Low -> Mid -> High -> Pan -> Gain -> Master
        source.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(pan);
        pan.connect(gain);
        gain.connect(this.masterGain);

        // Store refs
        this.sources.set(id, source);
        this.eqs.set(id, { low, mid, high });
        this.pans.set(id, pan);
        this.gains.set(id, gain);
    }

    updateTrack(id: string, params: AudioTrack) {
        const eq = this.eqs.get(id);
        const pan = this.pans.get(id);
        const gain = this.gains.get(id);

        if (eq) {
            eq.low.gain.value = params.eq.low;
            eq.mid.gain.value = params.eq.mid;
            eq.high.gain.value = params.eq.high;
        }
        if (pan) {
            pan.pan.value = params.pan;
        }
        if (gain) {
            // If muted or solo logic implies mute, set gain to 0
            // Solo logic is handled in the UI state mainly, but here we enforce volume
            gain.gain.value = params.isMuted ? 0 : (params.volume / 100);
        }
    }

    removeTrack(id: string) {
        // Disconnect everything to prevent memory leaks
        this.sources.get(id)?.disconnect();
        this.gains.get(id)?.disconnect();
        this.sources.delete(id);
        this.gains.delete(id);
        this.eqs.delete(id);
        this.pans.delete(id);
    }

    resume() {
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }
}

const App: React.FC = () => {
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>(Workspace.IMAGE);

  // --- IMAGE STATE ---
  const [activeMode, setActiveMode] = useState<ToolMode>(ToolMode.GENERATION);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [globalPrompt, setGlobalPrompt] = useState<string>('');
  
  // API Key
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [tempApiKey, setTempApiKey] = useState('');

  // --- VIDEO STATE ---
  const [videoPool, setVideoPool] = useState<VideoClip[]>([]);
  const [videoTracks, setVideoTracks] = useState<VideoTrack[]>([
    { id: 'v1', name: 'فيديو 1', clips: [], isMuted: false, isLocked: false },
    { id: 'v2', name: 'فيديو 2', clips: [], isMuted: false, isLocked: false },
    { id: 'v3', name: 'نصوص/FX', clips: [], isMuted: false, isLocked: false }
  ]);
  const [timelineAudioTracks, setTimelineAudioTracks] = useState<VideoTrack[]>([
      { id: 'a1', name: 'صوت 1', clips: [], isMuted: false, isLocked: false }
  ]); 
  
  const [videoHistory, setVideoHistory] = useState<string[]>([]);
  const [videoHistoryIndex, setVideoHistoryIndex] = useState(-1);

  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [videoEditTool, setVideoEditTool] = useState<'move' | 'razor'>('move');
  const [isMagnetEnabled, setIsMagnetEnabled] = useState(true);
  const [activeInspectorTab, setActiveInspectorTab] = useState<'props' | 'effects' | 'ai' | 'text'>('props');
  const [timelineScale, setTimelineScale] = useState(20); 

  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragOriginalStartTime, setDragOriginalStartTime] = useState(0);

  const [aiAnalysisResult, setAiAnalysisResult] = useState<string>('');
  const [aiPendingChanges, setAiPendingChanges] = useState<AiChangeItem[]>([]);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [aiIntroPrompt, setAiIntroPrompt] = useState('');

  // --- RECORDING STUDIO STATE ---
  const [isRecorderMode, setIsRecorderMode] = useState(false); // Controls UI hiding
  const [recordingState, setRecordingState] = useState<'idle' | 'capturing' | 'recording' | 'review'>('idle');
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const animationFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const renderStageRef = useRef<HTMLDivElement>(null);

  // Audio Studio Refs
  const [audioStudioTracks, setAudioStudioTracks] = useState<AudioTrack[]>([]);
  const audioStudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioGraphRef = useRef<AudioGraph | null>(null);
  const [isAudioStudioPlaying, setIsAudioStudioPlaying] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const timelineAudioInputRef = useRef<HTMLInputElement>(null); 
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null); 

  const activeImage = gallery.find(img => img.id === activeImageId);

  const videoTracksRef = useRef(videoTracks);
  const timelineAudioTracksRef = useRef(timelineAudioTracks);
  const videoHistoryRef = useRef(videoHistory);
  const videoHistoryIndexRef = useRef(videoHistoryIndex);

  // Max Time Calculation
  const maxTime = useMemo(() => {
      const allClips = [...videoTracks, ...timelineAudioTracks].flatMap(t => t.clips);
      if (allClips.length === 0) return 60;
      return Math.max(60, ...allClips.map(c => c.startTime + c.duration)) + 2;
  }, [videoTracks, timelineAudioTracks]);

  const timelineWidth = (maxTime * timelineScale) + HEADER_WIDTH + 100;

  useEffect(() => {
    videoTracksRef.current = videoTracks;
    timelineAudioTracksRef.current = timelineAudioTracks;
    videoHistoryRef.current = videoHistory;
    videoHistoryIndexRef.current = videoHistoryIndex;
  }, [videoTracks, timelineAudioTracks, videoHistory, videoHistoryIndex]);

  // --- AUDIO ENGINE INIT ---
  useEffect(() => {
      if (activeWorkspace === Workspace.AUDIO && !audioGraphRef.current) {
          audioGraphRef.current = new AudioGraph();
      }
      return () => {
          if (activeWorkspace !== Workspace.AUDIO && audioGraphRef.current) {
              audioGraphRef.current.ctx.close();
              audioGraphRef.current = null;
          }
      };
  }, [activeWorkspace]);

  // Sync Audio Engine with State
  useEffect(() => {
      if (!audioGraphRef.current) return;
      const graph = audioGraphRef.current;
      
      audioStudioTracks.forEach(track => {
          const el = audioStudioRefs.current.get(track.id);
          if (el) {
              graph.addTrack(track.id, el);
              graph.updateTrack(track.id, track);
          }
      });
  }, [audioStudioTracks, activeWorkspace]);

  function pushVideoHistory() {
      const state = JSON.stringify({ videoTracks: videoTracksRef.current, timelineAudioTracks: timelineAudioTracksRef.current });
      const currentHistory = videoHistoryRef.current;
      const currentIndex = videoHistoryIndexRef.current;
      
      const newHistory = currentHistory.slice(0, currentIndex + 1);
      newHistory.push(state);
      if (newHistory.length > 20) newHistory.shift();
      setVideoHistory(newHistory);
      setVideoHistoryIndex(newHistory.length - 1);
  }

  function handleVideoUndo() {
      const currentIndex = videoHistoryIndexRef.current;
      if (currentIndex > 0) {
          const newIndex = currentIndex - 1;
          setVideoHistoryIndex(newIndex);
          const state = JSON.parse(videoHistoryRef.current[newIndex]);
          setVideoTracks(state.videoTracks);
          setTimelineAudioTracks(state.timelineAudioTracks);
      }
  }

  function handleVideoRedo() {
      const currentIndex = videoHistoryIndexRef.current;
      const history = videoHistoryRef.current;
      if (currentIndex < history.length - 1) {
          const newIndex = currentIndex + 1;
          setVideoHistoryIndex(newIndex);
          const state = JSON.parse(history[newIndex]);
          setVideoTracks(state.videoTracks);
          setTimelineAudioTracks(state.timelineAudioTracks);
      }
  }

  function toggleVideoPlay() {
      if (isVideoPlaying) {
          setIsVideoPlaying(false);
          if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
          videoRefs.current.forEach(el => el.pause());
          audioPlayerRef.current?.pause();
      } else {
          lastTimeRef.current = performance.now();
          setIsVideoPlaying(true);
      }
  }

  function handleDeleteClip() {
      if (!selectedClipId) return;
      pushVideoHistory();
      setVideoTracks(prev => prev.map(t => ({...t, clips: t.clips.filter(c => c.id !== selectedClipId)})));
      setTimelineAudioTracks(prev => prev.map(t => ({...t, clips: t.clips.filter(c => c.id !== selectedClipId)})));
      setSelectedClipId(null);
  }

  function handleSplitAtPlayhead() {
      if (!selectedClipId) return;
      
      const allClips = [...videoTracks, ...timelineAudioTracks].flatMap(t => t.clips.map(c => ({...c, trackId: t.id, isAudio: timelineAudioTracks.includes(t)})));
      const clip = allClips.find(c => c.id === selectedClipId);
      
      if (!clip) return;
      
      // Calculate relative split time
      const relativeTime = roundTime(currentVideoTime - clip.startTime);
      
      if (relativeTime < 0.1 || (clip.duration - relativeTime) < 0.1) return;

      pushVideoHistory();
      
      const splitTime = relativeTime;
      // Important: calculate trimEnd to maintain data integrity
      const clipA: VideoClip = { 
          ...clip, 
          duration: splitTime, 
          trimEnd: clip.trimStart + splitTime 
      };
      
      const clipB: VideoClip = { 
          ...clip, 
          startTime: clip.startTime + splitTime, 
          trimStart: clip.trimStart + splitTime, 
          duration: roundTime(clip.duration - splitTime), 
          id: clip.id + '_split_' + Date.now() 
      };

      const updateTracks = (tracks: VideoTrack[]) => tracks.map(t => {
          if (t.id !== clip.trackId) return t;
          return { ...t, clips: t.clips.map(c => c.id === clip.id ? clipA : c).concat([clipB]) };
      });

      if (clip.isAudio) setTimelineAudioTracks(updateTracks);
      else setVideoTracks(updateTracks);
  }

  useEffect(() => {
    const handleOpenModal = () => setShowApiKeyModal(true);
    window.addEventListener('OPEN_API_KEY_MODAL', handleOpenModal);
    
    if (!process.env.API_KEY) {
      const stored = localStorage.getItem('GEMINI_API_KEY');
      if (stored) {
         process.env.API_KEY = stored;
      } else {
         setTimeout(() => setShowApiKeyModal(true), 1000);
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        if (isTyping) return;

        if (activeWorkspace === Workspace.VIDEO) {
            if (e.key === 'Delete' || e.key === 'Backspace') handleDeleteClip();
            if (e.key === ' ') { e.preventDefault(); toggleVideoPlay(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleVideoUndo(); }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); handleVideoRedo(); }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
        window.removeEventListener('OPEN_API_KEY_MODAL', handleOpenModal);
        window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeWorkspace, selectedClipId, isVideoPlaying]); 

  useEffect(() => {
     if (videoHistory.length === 0) pushVideoHistory();
  }, []);

  const animate = useCallback((time: number) => {
    if (lastTimeRef.current !== undefined) {
      const deltaTime = (time - lastTimeRef.current) / 1000;
      const safeDelta = Math.min(deltaTime, 0.1); 
      
      setCurrentVideoTime(prev => {
          const nextTime = prev + safeDelta;
          if (nextTime >= maxTime) {
              setIsVideoPlaying(false);
              // Auto-stop recording if we hit the end
              if (recordingState === 'recording') {
                  handleStopRecording();
              }
              return maxTime;
          }
          return nextTime;
      });
    }
    lastTimeRef.current = time;
    if (isVideoPlaying) {
        animationFrameRef.current = requestAnimationFrame(animate);
    }
  }, [maxTime, isVideoPlaying, recordingState]);

  useEffect(() => {
    if (isVideoPlaying && activeWorkspace === Workspace.VIDEO) {
      lastTimeRef.current = performance.now();
      animationFrameRef.current = requestAnimationFrame(animate);
    } else {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    }
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isVideoPlaying, activeWorkspace, animate]);

  const getAllActiveClips = () => {
      const visibleClips: { clip: VideoClip, track: VideoTrack, trackIndex: number }[] = [];
      const lookAhead = 0.05; 

      videoTracks.forEach((track, idx) => {
          if (track.isMuted) return; 
          const clip = track.clips.find(c => 
              (currentVideoTime + lookAhead) >= c.startTime && 
              currentVideoTime < (c.startTime + c.duration)
          );
          if (clip) {
              visibleClips.push({ clip, track, trackIndex: idx });
          }
      });
      visibleClips.sort((a, b) => a.trackIndex - b.trackIndex);

      let activeAudioClip: VideoClip | null = null;
      let activeAudioTrack: VideoTrack | null = null;
      for (const track of timelineAudioTracks) {
          if (track.isMuted) continue;
          const clip = track.clips.find(c => currentVideoTime >= c.startTime && currentVideoTime < (c.startTime + c.duration));
          if (clip) {
              activeAudioClip = clip;
              activeAudioTrack = track;
              break; 
          }
      }

      return { visibleClips, activeAudioClip, activeAudioTrack };
  };

  useEffect(() => {
    const { visibleClips, activeAudioClip, activeAudioTrack } = getAllActiveClips();

    visibleClips.forEach(({ clip, track }) => {
        const el = videoRefs.current.get(clip.id);
        if (el && clip.type === 'video' && el.readyState >= 1) {
            const clipTime = (currentVideoTime - clip.startTime) + clip.trimStart;
            
            // RELAXED TOLERANCE: prevents stuttering during playback
            const tolerance = isVideoPlaying ? 0.4 : 0.05;

            if (Math.abs(el.currentTime - clipTime) > tolerance) {
                el.currentTime = clipTime;
            }
            
            if (el.playbackRate !== (clip.speed || 100) / 100) {
                el.playbackRate = (clip.speed || 100) / 100;
            }

            if (isVideoPlaying && el.paused) {
                 el.play().catch(e => { }); 
            } else if (!isVideoPlaying && !el.paused) {
                 el.pause();
            }
            
            el.muted = track.isMuted;
            
            // AUDIO FADE CALCULATION
            let fadeFactor = 1;
            const timeInClip = currentVideoTime - clip.startTime;
            const timeFromEnd = (clip.startTime + clip.duration) - currentVideoTime;
            const curveType = clip.fadeCurve || 'smooth';

            if (timeInClip < clip.fadeIn) {
                fadeFactor = calculateFadeFactor(timeInClip / clip.fadeIn, curveType);
            } else if (timeFromEnd < clip.fadeOut) {
                fadeFactor = calculateFadeFactor(timeFromEnd / clip.fadeOut, curveType);
            }

            el.volume = Math.max(0, Math.min(1, ((clip.volume || 100) / 100) * fadeFactor));
        }
    });

    if (audioPlayerRef.current) {
        if (activeAudioClip) {
            if (!audioPlayerRef.current.src.includes(activeAudioClip.url)) {
                audioPlayerRef.current.src = activeAudioClip.url;
            }
            const clipTime = (currentVideoTime - activeAudioClip.startTime) + activeAudioClip.trimStart;
            if (audioPlayerRef.current.readyState >= 1) {
                const tolerance = isVideoPlaying ? 0.4 : 0.05;
                if (Math.abs(audioPlayerRef.current.currentTime - clipTime) > tolerance) {
                    audioPlayerRef.current.currentTime = clipTime;
                }
                audioPlayerRef.current.muted = activeAudioTrack ? activeAudioTrack.isMuted : false;
                
                let fadeFactor = 1;
                const timeInClip = currentVideoTime - activeAudioClip.startTime;
                const timeFromEnd = (activeAudioClip.startTime + activeAudioClip.duration) - currentVideoTime;
                const curveType = activeAudioClip.fadeCurve || 'smooth';

                if (timeInClip < activeAudioClip.fadeIn) {
                    fadeFactor = calculateFadeFactor(timeInClip / activeAudioClip.fadeIn, curveType);
                } else if (timeFromEnd < activeAudioClip.fadeOut) {
                    fadeFactor = calculateFadeFactor(timeFromEnd / activeAudioClip.fadeOut, curveType);
                }

                audioPlayerRef.current.volume = Math.max(0, Math.min(1, ((activeAudioClip.volume || 100) / 100) * fadeFactor));
                
                if (isVideoPlaying && audioPlayerRef.current.paused) {
                    audioPlayerRef.current.play().catch(e => {});
                } else if (!isVideoPlaying && !audioPlayerRef.current.paused) {
                    audioPlayerRef.current.pause();
                }
            }
        } else {
            audioPlayerRef.current.pause();
        }
    }
  }, [currentVideoTime, isVideoPlaying, videoTracks, timelineAudioTracks]);

  const saveApiKey = () => {
    if (tempApiKey.trim()) {
      localStorage.setItem('GEMINI_API_KEY', tempApiKey.trim());
      process.env.API_KEY = tempApiKey.trim();
      setShowApiKeyModal(false);
      setTempApiKey('');
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      Array.from(files).forEach((file: File) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const newImage: GalleryImage = {
            id: Math.random().toString(36).substr(2, 9),
            originalData: result,
            currentData: result,
            history: [result],
            historyIndex: 0,
            filters: DEFAULT_FILTERS,
            isProcessing: false,
            suggestions: []
          };
          setGallery(prev => {
             const updated = [...prev, newImage];
             if (!activeImageId) setActiveImageId(newImage.id); 
             return updated;
          });
        };
        reader.readAsDataURL(file);
      });
    }
    event.target.value = '';
  };

  const processSingleImage = async (image: GalleryImage, action: (base64: string) => Promise<string>) => {
    if (image.isProcessing) return;
    setGallery(prev => prev.map(img => img.id === image.id ? { ...img, isProcessing: true } : img));
    try {
      const result = await action(image.currentData);
      setGallery(prev => prev.map(img => {
          if (img.id !== image.id) return img;
          const newHistory = img.history.slice(0, img.historyIndex + 1);
          newHistory.push(result);
          // Limit history stack for images
          if (newHistory.length > MAX_HISTORY_STACK) newHistory.shift();

          return {
             ...img,
             currentData: result,
             history: newHistory,
             historyIndex: newHistory.length - 1,
             isProcessing: false
          };
      }));
    } catch (error: any) {
      console.error(error);
      setGallery(prev => prev.map(img => img.id === image.id ? { ...img, isProcessing: false } : img));
      alert(error.message);
    }
  };

  const handleExecuteActive = (overridePrompt?: string) => {
    const promptToUse = overridePrompt || globalPrompt;
    if (activeMode === ToolMode.GENERATION) {
       (async () => {
         try {
           const res = await generateImageFromText(promptToUse);
           const newImg: GalleryImage = {
             id: Math.random().toString(36).substr(2, 9),
             originalData: res,
             currentData: res,
             history: [res],
             historyIndex: 0,
             filters: DEFAULT_FILTERS,
             isProcessing: false,
             suggestions: []
           };
           setGallery(prev => [...prev, newImg]);
           setActiveImageId(newImg.id);
         } catch(e: any) { alert(e.message); }
       })();
       return;
    }
    if (!activeImage) return;
    let action: ((img: string) => Promise<string>) | null = null;
    if (activeMode === ToolMode.REMOVE_BG) action = (img) => removeBackground(img);
    else if (activeMode === ToolMode.OBJECT_REMOVAL) action = (img) => removeObject(img, promptToUse);
    else if (activeMode === ToolMode.REPLACE_BG) action = (img) => replaceBackground(img, promptToUse);
    else if (activeMode === ToolMode.RELIGHT) action = (img) => relightImage(img, promptToUse);
    else if (activeMode === ToolMode.UPSCALE) action = (img) => upscaleImage(img);
    else if (activeMode === ToolMode.NANO_BANANA) action = (img) => runNanoBanana(promptToUse, img);
    if (action) processSingleImage(activeImage, action!);
  };

  const handleBatchProcess = async () => {
      if (!activeImage) return;
      if (!window.confirm(`هل أنت متأكد من تطبيق التعديل الحالي على ${gallery.length} صورة؟`)) return;
      
      const mode = activeMode;
      const prompt = globalPrompt;

      let action: ((img: string) => Promise<string>) | null = null;
      if (mode === ToolMode.REMOVE_BG) action = (img) => removeBackground(img);
      else if (mode === ToolMode.NANO_BANANA) action = (img) => runNanoBanana(prompt, img);
      else if (mode === ToolMode.UPSCALE) action = (img) => upscaleImage(img);
      else if (mode === ToolMode.MANUAL) return; 

      if (action) {
          for (const img of gallery) {
              await processSingleImage(img, action);
          }
      }
      alert('تمت المعالجة بنجاح!');
  };

  const handleUndo = () => {
    if (!activeImage || activeImage.historyIndex <= 0) return;
    setGallery(prev => prev.map(img => {
      if (img.id !== activeImage.id) return img;
      const newIndex = img.historyIndex - 1;
      return { ...img, historyIndex: newIndex, currentData: img.history[newIndex] };
    }));
  };

  const handleRedo = () => {
    if (!activeImage || activeImage.historyIndex >= activeImage.history.length - 1) return;
    setGallery(prev => prev.map(img => {
      if (img.id !== activeImage.id) return img;
      const newIndex = img.historyIndex + 1;
      return { ...img, historyIndex: newIndex, currentData: img.history[newIndex] };
    }));
  };

  const updateFilters = (key: keyof ManualFilters, value: number) => {
    if (!activeImage) return;
    setGallery(prev => prev.map(img => img.id === activeImage.id ? {
      ...img, filters: { ...img.filters, [key]: value }
    } : img));
  };

  const applyFiltersToAll = () => {
      if (!activeImage) return;
      const currentFilters = activeImage.filters;
      setGallery(prev => prev.map(img => ({ ...img, filters: { ...currentFilters } })));
      alert("تم تطبيق الفلاتر على جميع الصور.");
  };

  const handleAnalyze = async () => {
    if (!activeImage) return;
    setGallery(prev => prev.map(img => img.id === activeImageId ? { ...img, isProcessing: true } : img));
    try {
        const suggestions = await analyzeImageForSuggestions(activeImage.currentData);
        setGallery(prev => prev.map(img => img.id === activeImageId ? { ...img, isProcessing: false, suggestions } : img));
        setActiveMode(ToolMode.SMART_DASHBOARD);
    } catch (e) {
        setGallery(prev => prev.map(img => img.id === activeImageId ? { ...img, isProcessing: false } : img));
    }
  };

  const handleApplySuggestion = (sug: any) => {
      setActiveMode(sug.tool as any);
      setGlobalPrompt(sug.prompt);
      setTimeout(() => handleExecuteActive(sug.prompt), 100);
  };

  const handleImportMedia = async (e: React.ChangeEvent<HTMLInputElement>, isTimelineAudio: boolean = false) => {
      const file = e.target.files?.[0];
      if (file) {
          const url = URL.createObjectURL(file);
          const isVideo = file.type.startsWith('video');
          const isAudio = file.type.startsWith('audio');
          
          let meta = { duration: 10, w: 1920, h: 1080 };

          if (isVideo || isAudio) {
             const el = isVideo ? document.createElement('video') : document.createElement('audio');
             el.preload = 'metadata';
             meta = await new Promise((resolve) => {
                 el.onloadedmetadata = () => resolve({ 
                     duration: el.duration || 10, 
                     w: (el as any).videoWidth || 1920, 
                     h: (el as any).videoHeight || 1080 
                 });
                 el.onerror = () => resolve(meta);
                 el.src = url;
             });
          }

          const newClip: VideoClip = {
              id: Date.now().toString(),
              name: file.name,
              url,
              type: isVideo ? 'video' : isAudio ? 'video' : 'image',
              originalDuration: meta.duration,
              width: meta.w,
              height: meta.h,
              duration: isVideo || isAudio ? meta.duration : 5,
              startTime: 0,
              trimStart: 0,
              trimEnd: isVideo || isAudio ? meta.duration : 5,
              opacity: 100,
              scale: 100,
              rotation: 0,
              positionX: 0,
              positionY: 0,
              blendMode: 'normal',
              brightness: 100,
              contrast: 100,
              saturation: 100,
              hueRotate: 0,
              blur: 0,
              filterPreset: 'none',
              fadeIn: 0,
              fadeOut: 0,
              fadeCurve: 'smooth',
              volume: 100,
              speed: 100,
          };

          if (isTimelineAudio) {
              setTimelineAudioTracks(prev => {
                  const newTracks = [...prev];
                  newTracks[0].clips.push(newClip);
                  return newTracks;
              });
          } else {
              setVideoPool(prev => [...prev, newClip]);
          }
      }
      e.target.value = '';
  };

  const handleAddText = () => {
      const newClip: VideoClip = {
          id: 'txt_' + Date.now().toString(),
          name: 'نص جديد',
          url: '',
          type: 'text',
          originalDuration: 5,
          width: 1920,
          height: 1080,
          duration: 5,
          startTime: 0,
          trimStart: 0,
          trimEnd: 5,
          opacity: 100,
          scale: 100,
          rotation: 0,
          positionX: 0,
          positionY: 0,
          blendMode: 'normal',
          brightness: 100,
          contrast: 100,
          saturation: 100,
          hueRotate: 0,
          blur: 0,
          filterPreset: 'none',
          fadeIn: 0,
          fadeOut: 0,
          fadeCurve: 'smooth',
          volume: 0,
          speed: 100,
          textContent: 'اكتب النص هنا',
          fontSize: 80,
          textColor: '#ffffff',
          fontFamily: 'Cairo, sans-serif'
      };
      setVideoPool(prev => [...prev, newClip]);
  };

  // --- CRITICAL FIX: APPLY CSS FILTERS TO CANVAS CONTEXT ---
  const captureCurrentFrame = async (): Promise<string | null> => {
     if (!renderStageRef.current) return null;
     
     const { visibleClips } = getAllActiveClips();
     const canvas = document.createElement('canvas');
     canvas.width = 1280;
     canvas.height = 720;
     const ctx = canvas.getContext('2d');
     if (!ctx) return null;
     ctx.clearRect(0,0, canvas.width, canvas.height);
     
     for (const { clip } of visibleClips) {
         ctx.save();
         
         // Apply Transform
         ctx.translate(canvas.width/2 + clip.positionX, canvas.height/2 + clip.positionY);
         ctx.rotate((clip.rotation * Math.PI) / 180);
         ctx.scale(clip.scale/100, clip.scale/100);
         ctx.translate(-canvas.width/2, -canvas.height/2);
         ctx.globalAlpha = clip.opacity / 100;

         // APPLY FILTERS TO AI CONTEXT
         const filters = [
            `brightness(${clip.brightness}%)`,
            `contrast(${clip.contrast}%)`,
            `saturate(${clip.saturation}%)`,
            `hue-rotate(${clip.hueRotate}deg)`,
            `blur(${clip.blur}px)`,
            FILTER_PRESETS[clip.filterPreset || 'none']
         ].join(' ');
         ctx.filter = filters;

         if (clip.type === 'video') {
             const vid = videoRefs.current.get(clip.id);
             if (vid && vid.readyState >= 2) {
                 try {
                    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
                 } catch(e) { }
             }
         } else if (clip.type === 'image') {
             const img = new Image();
             img.crossOrigin = 'Anonymous';
             img.src = clip.url;
             await new Promise(r => { img.onload = r; img.onerror = r; });
             try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch(e) { }
         } else if (clip.type === 'text') {
             ctx.font = `${clip.fontSize}px Cairo`;
             ctx.fillStyle = clip.textColor || 'white';
             ctx.fillText(clip.textContent || '', 100, 300);
         }
         ctx.restore();
     }
     return canvas.toDataURL('image/jpeg', 0.8);
  };

  const getSelectedClip = () => {
      const all = [...videoTracks.flatMap(t => t.clips), ...timelineAudioTracks.flatMap(t => t.clips)];
      return all.find(x => x.id === selectedClipId) || null;
  };

  const handleAiVideoAnalysis = async () => {
    setIsAiAnalyzing(true);
    setAiAnalysisResult('');
    setAiPendingChanges([]);
    
    const wasPlaying = isVideoPlaying;
    if (wasPlaying) toggleVideoPlay();
    await new Promise(r => setTimeout(r, 200));

    try {
        const frameBase64 = await captureCurrentFrame();
        if (frameBase64) {
             const result = await analyzeVideoFrameForEditing(frameBase64);
             setAiAnalysisResult(result.explanation);
             
             // Calculate pending changes
             const clip = getSelectedClip();
             if (clip) {
                 const changes: AiChangeItem[] = [];
                 if (result.brightness && result.brightness !== clip.brightness) {
                     changes.push({ key: 'brightness', label: 'السطوع', oldValue: clip.brightness, newValue: result.brightness, selected: true });
                 }
                 if (result.contrast && result.contrast !== clip.contrast) {
                     changes.push({ key: 'contrast', label: 'التباين', oldValue: clip.contrast, newValue: result.contrast, selected: true });
                 }
                 if (result.saturation && result.saturation !== clip.saturation) {
                     changes.push({ key: 'saturation', label: 'التشبع', oldValue: clip.saturation, newValue: result.saturation, selected: true });
                 }
                 if (result.filterPreset && result.filterPreset !== 'none' && result.filterPreset !== clip.filterPreset) {
                     changes.push({ key: 'filterPreset', label: 'الفلتر', oldValue: clip.filterPreset, newValue: result.filterPreset, selected: true });
                 }
                 setAiPendingChanges(changes);
             }
        } else {
             setAiAnalysisResult("لم يتم العثور على محتوى.");
        }
    } catch (e: any) {
        setAiAnalysisResult("خطأ: " + e.message);
    }
    setIsAiAnalyzing(false);
  };

  const handleApplyAiSuggestions = () => {
      if (!selectedClipId || aiPendingChanges.length === 0) {
        if(!selectedClipId) alert("يرجى تحديد مقطع فيديو أولاً.");
        return;
      }
      pushVideoHistory();
      const updates: Partial<VideoClip> = {};
      aiPendingChanges.forEach(change => {
          if (change.selected) {
              (updates as any)[change.key] = change.newValue;
          }
      });
      const applyUpdate = (tracks: VideoTrack[]) => tracks.map(t => ({
          ...t,
          clips: t.clips.map(c => c.id === selectedClipId ? { ...c, ...updates } : c)
      }));
      setVideoTracks(applyUpdate);
      setAiPendingChanges([]); // Clear pending changes after apply
      alert("تم تطبيق الإعدادات المختارة بنجاح!");
  };

  const toggleAiChangeSelection = (index: number) => {
      setAiPendingChanges(prev => prev.map((item, i) => i === index ? { ...item, selected: !item.selected } : item));
  };

  const handleGenerateIntro = async () => {
      if(!aiIntroPrompt) return;
      setIsAiAnalyzing(true);
      try {
          const videoUrl = await generateVideo(aiIntroPrompt);
          const newClip: VideoClip = {
              id: 'ai_gen_' + Date.now(),
              name: 'AI: ' + aiIntroPrompt.slice(0, 10),
              url: videoUrl,
              type: 'video',
              originalDuration: 5, 
              width: 1280,
              height: 720,
              duration: 5,
              startTime: 0,
              trimStart: 0,
              trimEnd: 5,
              opacity: 100,
              scale: 100,
              rotation: 0,
              positionX: 0,
              positionY: 0,
              blendMode: 'normal',
              brightness: 100,
              contrast: 100,
              saturation: 100,
              hueRotate: 0,
              blur: 0,
              filterPreset: 'none',
              fadeIn: 1,
              fadeOut: 1,
              fadeCurve: 'smooth',
              volume: 100,
              speed: 100,
          };
          setVideoPool(prev => [...prev, newClip]);
          setAiIntroPrompt('');
          alert("تم التوليد بنجاح!");
      } catch(e: any) {
          alert("فشل التوليد: " + e.message);
      }
      setIsAiAnalyzing(false);
  };

  const getTimelineTimeFromEvent = (e: React.MouseEvent | React.DragEvent) => {
      if (!timelineContainerRef.current) return 0;
      const rect = timelineContainerRef.current.getBoundingClientRect();
      const pixelX = e.clientX - rect.left;
      const contentX = pixelX - HEADER_WIDTH;
      const time = Math.max(0, contentX / timelineScale);
      return roundTime(time);
  };

  const handleTrackDrop = (e: React.DragEvent, trackId: string, isAudioTrack: boolean) => {
      e.preventDefault();
      const clipData = e.dataTransfer.getData('clip');
      if (!clipData) return;
      
      const sourceClip = JSON.parse(clipData) as VideoClip;
      const dropTime = getTimelineTimeFromEvent(e);

      let isTrackEmpty = false;
      if (isAudioTrack) {
          const track = timelineAudioTracks.find(t => t.id === trackId);
          if (track && track.clips.length === 0) isTrackEmpty = true;
      } else {
          const track = videoTracks.find(t => t.id === trackId);
          if (track && track.clips.length === 0) isTrackEmpty = true;
      }
      
      const finalTime = isTrackEmpty ? 0 : dropTime;

      const newClip: VideoClip = {
          ...sourceClip,
          id: Date.now().toString(),
          startTime: finalTime
      };

      pushVideoHistory(); 
      if (isAudioTrack) {
          setTimelineAudioTracks(prev => prev.map(t => t.id === trackId ? {...t, clips: [...t.clips, newClip]} : t));
      } else {
          setVideoTracks(prev => prev.map(t => t.id === trackId ? {...t, clips: [...t.clips, newClip]} : t));
      }
  };

  const handleClipMouseDown = (e: React.MouseEvent, clip: VideoClip, trackId: string, isAudioTrack: boolean) => {
      e.stopPropagation();
      try {
        if (videoEditTool === 'razor') {
            const globalTime = getTimelineTimeFromEvent(e);
            const relativeTime = roundTime(globalTime - clip.startTime);
            
            if (relativeTime < 0.1 || (clip.duration - relativeTime) < 0.1) return;

            pushVideoHistory(); 

            const splitTime = relativeTime;
            const clipA: VideoClip = {
                ...clip,
                duration: splitTime,
                trimEnd: clip.trimStart + splitTime,
            };
            const clipB: VideoClip = {
                ...clip,
                startTime: clip.startTime + splitTime,
                trimStart: clip.trimStart + splitTime,
                duration: roundTime(clip.duration - splitTime), 
                id: clip.id + '_split_' + Date.now()
            };
            
            const updateTracks = (tracks: VideoTrack[]) => tracks.map(t => {
                if (t.id !== trackId) return t;
                return { ...t, clips: t.clips.map(c => c.id === clip.id ? clipA : c).concat([clipB]) };
            });

            if (isAudioTrack) setTimelineAudioTracks(updateTracks);
            else setVideoTracks(updateTracks);
            return;
        }

        setSelectedClipId(clip.id);
        if (clip.type === 'text') setActiveInspectorTab('text');
        else setActiveInspectorTab('props');

        setDraggingClipId(clip.id);
        setDragStartX(e.clientX);
        setDragOriginalStartTime(clip.startTime);
      } catch (err) {
          console.error("Split/Edit Error:", err);
      }
  };

  const handleDragStart = (e: React.DragEvent, clip: VideoClip) => {
      e.dataTransfer.setData('clip', JSON.stringify(clip));
      e.dataTransfer.effectAllowed = 'copy';
  };
  const handleTrackDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  
  const updatePlayheadPosition = (e: React.MouseEvent) => {
     setCurrentVideoTime(getTimelineTimeFromEvent(e));
  };
  
  const handleTimelineMouseDownWrapper = (e: React.MouseEvent) => {
     setIsScrubbing(true); setIsVideoPlaying(false); updatePlayheadPosition(e);
  };
  
  const updateSelectedClip = (updates: Partial<VideoClip>) => {
      if (!selectedClipId) return;
      const applyUpdate = (tracks: VideoTrack[]) => tracks.map(t => ({
          ...t,
          clips: t.clips.map(c => c.id === selectedClipId ? { ...c, ...updates } : c)
      }));
      setVideoTracks(applyUpdate);
      setTimelineAudioTracks(applyUpdate);
  };
  const toggleTrackMute = (trackId: string, isAudioTrack: boolean) => {
      pushVideoHistory();
      if (isAudioTrack) setTimelineAudioTracks(prev => prev.map(t => t.id === trackId ? { ...t, isMuted: !t.isMuted } : t));
      else setVideoTracks(prev => prev.map(t => t.id === trackId ? { ...t, isMuted: !t.isMuted } : t));
  };
  const handleTimelineMouseMove = (e: React.MouseEvent) => {
      if (isScrubbing) { updatePlayheadPosition(e); return; }
      if (!draggingClipId || videoEditTool !== 'move') return;
      const deltaPixels = e.clientX - dragStartX;
      const deltaSeconds = deltaPixels / timelineScale;
      let newStartTime = dragOriginalStartTime + deltaSeconds;
      
      newStartTime = roundTime(newStartTime);
      if (newStartTime < 0) newStartTime = 0;
      
      if (isMagnetEnabled) {
          const allClips = [...videoTracks, ...timelineAudioTracks].flatMap(t => t.clips);
          const snapThreshold = 15 / timelineScale;
          for (const other of allClips) {
              if (other.id === draggingClipId) continue;
              if (Math.abs(newStartTime - (other.startTime + other.duration)) < snapThreshold) newStartTime = other.startTime + other.duration;
              if (Math.abs(newStartTime - other.startTime) < snapThreshold) newStartTime = other.startTime;
          }
          if (newStartTime < snapThreshold) newStartTime = 0;
      }
      const updateClipInTracks = (tracks: VideoTrack[]) => tracks.map(t => ({
          ...t, clips: t.clips.map(c => c.id === draggingClipId ? { ...c, startTime: newStartTime } : c)
      }));
      setVideoTracks(updateClipInTracks);
      setTimelineAudioTracks(updateClipInTracks);
  };
  const handleTimelineMouseUp = () => {
      if (draggingClipId) pushVideoHistory();
      setDraggingClipId(null); setIsScrubbing(false);
  };
  const handleAudioStudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
        setAudioStudioTracks(prev => [...prev, {
            id: Date.now().toString(), name: file.name, url: URL.createObjectURL(file), duration: 60, volume: 80, pan: 0, isMuted: false, isSolo: false, eq: { low: 0, mid: 0, high: 0 }, reverb: 0
        }]);
    }
    e.target.value = '';
  };
  const toggleAudioStudioPlay = () => {
      if (!audioGraphRef.current) return;
      audioGraphRef.current.resume();
      
      if(isAudioStudioPlaying) {
          setIsAudioStudioPlaying(false);
          audioStudioRefs.current.forEach(a => a.pause());
      } else {
          setIsAudioStudioPlaying(true);
          audioStudioRefs.current.forEach(a => a.play().catch(()=>{}));
      }
  };
  const updateAudioTrack = (id: string, updates: Partial<AudioTrack>) => {
      setAudioStudioTracks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };
  
  const handleSaveProject = () => {
    const project = { gallery: gallery.map(g => ({...g, history: []})), videoTracks, timelineAudioTracks, audioStudioTracks };
    const blob = new Blob([JSON.stringify(project)], {type: "application/json"});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `project_${Date.now()}.ai-studio`;
    link.click();
  };

  const enterRecorderMode = () => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        alert("عذراً، هذا المتصفح لا يدعم تسجيل الشاشة.");
        return;
      }
      setIsRecorderMode(true); 
      setRecordingState('idle');
      setRecordedBlob(null);
      setCurrentVideoTime(0);
      setIsVideoPlaying(false);
  };

  const exitRecorderMode = () => {
      setIsRecorderMode(false);
      setRecordingState('idle');
      setRecordedBlob(null);
      if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
      }
  };

  const handleStartCapture = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser' },
            audio: true
        });
        
        stream.getVideoTracks()[0].onended = () => {
             if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                 mediaRecorderRef.current.stop();
             } else {
                 exitRecorderMode();
             }
        };

        streamRef.current = stream;
        const mimeTypes = ["video/mp4", "video/webm; codecs=vp9", "video/webm; codecs=vp8", "video/webm", ""];
        const mimeType = mimeTypes.find(type => type === "" || MediaRecorder.isTypeSupported(type));

        const options: MediaRecorderOptions = { videoBitsPerSecond: 8000000 };
        if (mimeType) options.mimeType = mimeType;

        const recorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = recorder;
        recordedChunksRef.current = [];

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunksRef.current.push(e.data);
        };

        recorder.onstop = () => {
            const blob = new Blob(recordedChunksRef.current, { type: mimeType || 'video/webm' });
            setRecordedBlob(blob);
            setRecordingState('review');
            stream.getTracks().forEach(track => track.stop());
            setIsVideoPlaying(false);
        };

        setRecordingState('capturing'); 
      } catch (err: any) {
          console.error("Error starting capture:", err);
          if (err.name === 'NotAllowedError') {
              setIsRecorderMode(false);
          } else if (err.message && err.message.indexOf('permissions policy') !== -1) {
              alert("عذراً، تسجيل الشاشة غير مدعوم في هذه البيئة بسبب قيود الأمان (Permissions Policy).");
              setIsRecorderMode(false);
          } else {
              alert("فشل بدء الالتقاط: " + err.message);
              setIsRecorderMode(false);
          }
      }
  };

  const handleStartRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'inactive') {
          mediaRecorderRef.current.start(1000);
          setRecordingState('recording');
          setCurrentVideoTime(0);
          setIsVideoPlaying(true);
      }
  };

  const handleStopRecording = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          setIsVideoPlaying(false);
      }
  };

  const handleDownloadRecording = () => {
      if (!recordedBlob) return;
      const url = URL.createObjectURL(recordedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recording_${Date.now()}.webm`;
      a.click();
  };

  const handleLoadProject = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const json = JSON.parse(e.target?.result as string);
            if (json.gallery) setGallery(json.gallery);
            if (json.videoTracks) setVideoTracks(json.videoTracks);
            if (json.timelineAudioTracks) setTimelineAudioTracks(json.timelineAudioTracks);
            if (json.audioStudioTracks) setAudioStudioTracks(json.audioStudioTracks);
            alert("تم تحميل المشروع بنجاح!");
        } catch (err) {
            alert("فشل تحميل المشروع: ملف تالف.");
        }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleDownloadImage = () => {
      if (!activeImage) return;
      const link = document.createElement('a');
      link.href = activeImage.currentData;
      link.download = `image_${Date.now()}.png`;
      link.click();
  };
  
  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden text-slate-100 bg-slate-900 font-cairo"
         onMouseUp={handleTimelineMouseUp} 
         onMouseMove={handleTimelineMouseMove}>
      
      <input type="file" ref={fileInputRef} className="hidden" multiple onChange={handleFileUpload} accept="image/*" />
      <input type="file" ref={projectInputRef} className="hidden" accept=".ai-studio" onChange={handleLoadProject} />

      {/* API Key Modal */}
      {showApiKeyModal && (
          <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6">
                  <h3 className="text-xl font-bold mb-4">إعداد مفتاح Gemini API</h3>
                  <input type="password" value={tempApiKey} onChange={(e) => setTempApiKey(e.target.value)} placeholder="AIza..." className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 mb-4" />
                  <button onClick={saveApiKey} className="w-full py-3 bg-indigo-600 rounded-xl font-bold">حفظ</button>
              </div>
          </div>
      )}

      {/* SIDEBAR */}
      {!isRecorderMode && (
      <aside className="w-16 lg:w-20 bg-slate-950 border-l border-slate-800 flex flex-col z-20 shadow-xl shrink-0 items-center py-4 gap-4">
         <div className="w-10 h-10 rounded bg-indigo-600 flex items-center justify-center font-bold text-lg mb-4">S</div>
         <button onClick={() => setActiveWorkspace(Workspace.IMAGE)} className={`p-3 rounded-xl ${activeWorkspace === Workspace.IMAGE ? 'bg-indigo-600' : ''}`}><Icons.Image /></button>
         <button onClick={() => setActiveWorkspace(Workspace.VIDEO)} className={`p-3 rounded-xl ${activeWorkspace === Workspace.VIDEO ? 'bg-indigo-600' : ''}`}><Icons.Film /></button>
         <button onClick={() => setActiveWorkspace(Workspace.AUDIO)} className={`p-3 rounded-xl ${activeWorkspace === Workspace.AUDIO ? 'bg-indigo-600' : ''}`}><Icons.Mic /></button>
      </aside>
      )}

      {/* SECONDARY SIDEBAR */}
      {!isRecorderMode && (
      <div className="w-64 bg-slate-950 border-l border-slate-800 flex flex-col z-10 shrink-0">
          <div className="p-4 border-b border-slate-800 font-bold text-lg">
             {activeWorkspace === Workspace.IMAGE ? 'الأدوات' : activeWorkspace === Workspace.VIDEO ? 'مكتبة الوسائط' : 'الملفات الصوتية'}
          </div>
          <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
            {activeWorkspace === Workspace.IMAGE && (
                <div className="space-y-1">
                    {[
                      { id: ToolMode.GENERATION, label: 'توليد الصور', icon: Icons.Image },
                      { id: ToolMode.SMART_DASHBOARD, label: 'الداشبورد الذكي', icon: Icons.Grid },
                      { id: ToolMode.NANO_BANANA, label: 'تعديل سريع (Nano)', icon: Icons.Rocket },
                      { id: ToolMode.REMOVE_BG, label: 'إزالة الخلفية', icon: Icons.Scissors },
                      { id: ToolMode.OBJECT_REMOVAL, label: 'حذف عناصر', icon: Icons.Eraser },
                      { id: ToolMode.REPLACE_BG, label: 'استبدال الخلفية', icon: Icons.Layers },
                      { id: ToolMode.UPSCALE, label: 'تحسين الجودة', icon: Icons.Zap },
                      { id: ToolMode.RELIGHT, label: 'تغيير الإضاءة', icon: Icons.Sun },
                      { id: ToolMode.MANUAL, label: 'تعديل يدوي', icon: Icons.Sliders },
                    ].map(tool => (
                        <button key={tool.id} onClick={() => setActiveMode(tool.id)} className={`w-full flex items-center gap-3 p-3 rounded-xl text-right transition-all ${activeMode === tool.id ? 'bg-slate-800 text-indigo-400' : 'hover:bg-slate-900 text-slate-400'}`}>
                           <tool.icon className="w-5 h-5" /> <span className="text-sm font-medium">{tool.label}</span>
                        </button>
                    ))}
                </div>
            )}
            
            {activeWorkspace === Workspace.VIDEO && (
                <div className="space-y-4 p-2">
                    <button onClick={() => videoInputRef.current?.click()} className="w-full py-4 border-2 border-dashed border-slate-700 rounded-xl flex flex-col items-center justify-center text-slate-500 hover:text-white"><Icons.Plus className="mb-2"/><span className="text-xs">استيراد فيديو/صورة</span></button>
                    <input type="file" ref={videoInputRef} className="hidden" accept="video/*,image/*" onChange={(e) => handleImportMedia(e, false)} />
                    <button onClick={handleAddText} className="w-full py-3 bg-slate-800 rounded-xl flex items-center justify-center gap-2"><Icons.Type className="w-4 h-4" /> <span className="text-xs">إضافة نص</span></button>
                    <button onClick={() => timelineAudioInputRef.current?.click()} className="w-full py-3 bg-slate-800 rounded-xl flex items-center justify-center gap-2"><Icons.Music className="w-4 h-4" /> <span className="text-xs">إضافة صوت</span></button>
                    <input type="file" ref={timelineAudioInputRef} className="hidden" accept="audio/*" onChange={(e) => handleImportMedia(e, true)} />

                    <div className="grid grid-cols-2 gap-2 mt-2">
                        {videoPool.map(clip => (
                            <div key={clip.id} draggable onDragStart={(e) => handleDragStart(e, clip)} className="aspect-square bg-slate-800 rounded border border-slate-700 flex items-center justify-center overflow-hidden cursor-grab relative">
                                {clip.type === 'video' ? <Icons.Video className="opacity-50"/> : clip.type === 'text' ? <Icons.Type className="w-8 h-8"/> : <img src={clip.url} className="w-full h-full object-cover"/>}
                                <div className="absolute bottom-0 w-full bg-black/60 text-[10px] p-1 truncate">{clip.name}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
             {activeWorkspace === Workspace.AUDIO && (
                <div className="space-y-4 p-2">
                    <button onClick={() => audioInputRef.current?.click()} className="w-full py-3 bg-indigo-600 rounded-lg font-bold flex items-center justify-center gap-2"><Icons.Plus /> استيراد صوت</button>
                    <input type="file" ref={audioInputRef} className="hidden" accept="audio/*" onChange={handleAudioStudioUpload} />
                </div>
            )}
        </div>
      </div>
      )}

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        {!isRecorderMode && (
        <header className="h-14 border-b border-slate-800 bg-slate-900 flex items-center justify-between px-4 shrink-0">
            <h1 className="font-bold text-lg">{activeWorkspace === Workspace.IMAGE ? 'محرر الصور' : activeWorkspace === Workspace.VIDEO ? 'المونتاج' : 'ستوديو الصوت'}</h1>
            <div className="flex gap-2">
                <button onClick={handleSaveProject} title="حفظ المشروع"><Icons.Save /></button>
                <button onClick={() => projectInputRef.current?.click()} title="فتح مشروع"><Icons.Folder /></button>
                {activeWorkspace === Workspace.IMAGE && <button onClick={handleDownloadImage} title="تحميل الصورة"><Icons.Download /></button>}
                <button onClick={() => setShowApiKeyModal(true)} title="الإعدادات"><Icons.Settings /></button>
            </div>
        </header>
        )}

        {/* IMAGE WORKSPACE */}
        {activeWorkspace === Workspace.IMAGE && !isRecorderMode && (
             <div className="flex h-full">
                <div className="flex-1 flex flex-col relative">
                     <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4 bg-slate-900/50">
                        <div className="flex gap-2">
                            <button onClick={handleAnalyze} className="bg-indigo-600 px-3 py-1 rounded text-xs flex items-center gap-2"><Icons.Sparkles className="w-4 h-4"/> تحليل ذكي</button>
                            <button onClick={handleUndo} disabled={!activeImage}><Icons.Undo/></button>
                            <button onClick={handleRedo} disabled={!activeImage}><Icons.Redo/></button>
                        </div>
                     </div>
                     <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-slate-950">
                         {activeImage && (
                            <div className="relative shadow-2xl max-w-full max-h-[70vh]">
                                 <img src={activeImage.currentData} className="max-w-full max-h-[70vh] object-contain"
                                    style={{ filter: `brightness(${activeImage.filters.brightness}%) contrast(${activeImage.filters.contrast}%) saturate(${activeImage.filters.saturation}%) blur(${activeImage.filters.blur}px) grayscale(${activeImage.filters.grayscale}%) sepia(${activeImage.filters.sepia}%)` }}
                                 />
                                 {activeImage.isProcessing && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><Icons.Wand className="w-10 h-10 animate-spin"/></div>}
                            </div>
                         )}
                     </div>
                     <div className="h-24 bg-slate-950 border-t border-slate-800 flex items-center gap-2 px-4 overflow-x-auto custom-scrollbar shrink-0">
                         <button onClick={() => fileInputRef.current?.click()} className="w-16 h-16 border-2 border-dashed border-slate-700 flex items-center justify-center"><Icons.Plus/></button>
                         {gallery.map(img => (
                             <div key={img.id} onClick={() => setActiveImageId(img.id)} className={`w-16 h-16 rounded border-2 cursor-pointer relative ${activeImageId === img.id ? 'border-indigo-500' : 'border-slate-800'}`}>
                                 <img src={img.currentData} className="w-full h-full object-cover"/>
                             </div>
                         ))}
                     </div>
                </div>
                {activeImage && (
                    <div className="w-80 bg-slate-950 border-r border-slate-800 p-4 overflow-y-auto">
                        {activeMode === ToolMode.MANUAL ? (
                            <div className="space-y-6">
                                {Object.keys(DEFAULT_FILTERS).map(key => (
                                    <div key={key}>
                                        <div className="flex justify-between text-xs font-bold text-slate-400 uppercase"><span>{key}</span><span>{(activeImage.filters as any)[key]}</span></div>
                                        <input type="range" min="0" max={key === 'blur' ? 20 : 200} value={(activeImage.filters as any)[key]} onChange={(e) => updateFilters(key as any, Number(e.target.value))} className="w-full h-1 bg-slate-800 rounded-full appearance-none accent-indigo-500" />
                                    </div>
                                ))}
                                <button onClick={applyFiltersToAll} className="w-full py-2 border border-indigo-600 text-indigo-400 rounded-xl mt-4 text-xs font-bold flex items-center justify-center gap-2">
                                    <Icons.Batch className="w-4 h-4"/> تطبيق على الكل
                                </button>
                            </div>
                        ) : activeMode === ToolMode.SMART_DASHBOARD ? (
                            <div className="space-y-4 h-full flex flex-col">
                                <h3 className="font-bold text-indigo-400 mb-2 flex items-center gap-2"><Icons.Sparkles className="w-4 h-4"/> لوحة التحليل الذكي</h3>
                                {activeImage.suggestions.length > 0 ? (
                                    <div className="space-y-3 overflow-y-auto custom-scrollbar flex-1 pr-1">
                                        {activeImage.suggestions.map((sug, i) => (
                                            <div key={i} className="group relative bg-slate-900 border border-slate-800 hover:border-indigo-500 p-4 rounded-xl cursor-pointer transition-all hover:shadow-lg hover:shadow-indigo-900/20" onClick={() => handleApplySuggestion(sug)}>
                                                <div className="flex justify-between items-start mb-2">
                                                    <div className="font-bold text-sm text-white">{sug.label}</div>
                                                    <Icons.Wand className="w-4 h-4 text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                </div>
                                                <div className="text-xs text-slate-400 mb-3 leading-relaxed">{sug.description}</div>
                                                <div className="flex items-center justify-between">
                                                    <div className="text-[10px] bg-slate-800 text-slate-300 px-2 py-1 rounded uppercase tracking-wider">{sug.tool}</div>
                                                    <span className="text-[10px] text-indigo-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">تطبيق ←</span>
                                                </div>
                                            </div>
                                        ))}
                                        <button onClick={handleAnalyze} className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-colors mt-4">
                                            إعادة تحليل الصورة
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-500 space-y-4 p-4 border-2 border-dashed border-slate-800 rounded-xl">
                                        <Icons.Grid className="w-12 h-12 opacity-20"/>
                                        <p className="text-sm">لم يتم تحليل الصورة بعد.</p>
                                        <button onClick={handleAnalyze} disabled={activeImage.isProcessing} className="bg-indigo-600 text-white px-6 py-2 rounded-full font-bold shadow-lg hover:shadow-indigo-500/20 transition-all hover:scale-105 active:scale-95">
                                            {activeImage.isProcessing ? 'جاري التحليل...' : 'بدء التحليل الآن'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : activeMode === ToolMode.NANO_BANANA ? (
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-2">
                                    {['Cartoon', 'Cyberpunk', 'Oil Painting', 'Sketch', '3D Render', 'HDR'].map(style => (
                                        <button key={style} onClick={() => setGlobalPrompt(style)} className="text-xs bg-slate-900 p-2 rounded hover:bg-slate-800 border border-slate-700">{style}</button>
                                    ))}
                                </div>
                                <textarea value={globalPrompt} onChange={(e) => setGlobalPrompt(e.target.value)} placeholder="صف التعديل (مثال: اجعلها كرتون)..." className="w-full h-24 bg-slate-900 border border-slate-700 rounded p-3 text-sm"></textarea>
                                <button onClick={() => handleExecuteActive()} className="w-full py-3 bg-indigo-600 rounded font-bold">تنفيذ (سريع)</button>
                                <button onClick={handleBatchProcess} className="w-full py-2 border border-indigo-600 text-indigo-400 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                                    <Icons.Batch className="w-4 h-4"/> تطبيق على الكل
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <textarea value={globalPrompt} onChange={(e) => setGlobalPrompt(e.target.value)} placeholder="وصف التعديل..." className="w-full h-24 bg-slate-900 border border-slate-700 rounded p-3 text-sm"></textarea>
                                <button onClick={() => handleExecuteActive()} className="w-full py-3 bg-indigo-600 rounded font-bold">تنفيذ</button>
                                <button onClick={handleBatchProcess} className="w-full py-2 border border-indigo-600 text-indigo-400 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                                    <Icons.Batch className="w-4 h-4"/> تطبيق على الكل
                                </button>
                            </div>
                        )}
                    </div>
                )}
             </div>
        )}

        {/* VIDEO WORKSPACE */}
        {activeWorkspace === Workspace.VIDEO && (
            <div className="flex-1 flex flex-col h-full bg-[#121212]">
                <div className="flex-1 flex min-h-0 relative">
                    {/* PREVIEW */}
                    <div className={`bg-[#0a0a0a] relative flex items-center justify-center overflow-hidden p-8 transition-all duration-300 ${isRecorderMode ? 'w-full h-full fixed inset-0 z-50' : 'flex-1'}`}>
                         <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(45deg, #1a1a1a 25%, transparent 25%), linear-gradient(-45deg, #1a1a1a 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a1a1a 75%), linear-gradient(-45deg, transparent 75%, #1a1a1a 75%)', backgroundSize: '20px 20px', backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px' }}></div>
                         <audio ref={audioPlayerRef} className="hidden" crossOrigin="anonymous" />
                         
                         <div ref={renderStageRef} className="relative shadow-2xl overflow-hidden ring-1 ring-[#333]" style={{ width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%', aspectRatio: '16/9' }}>
                             {recordingState === 'recording' && (
                                <div className="absolute top-4 right-4 bg-red-600 text-white text-xs px-3 py-1.5 rounded-full animate-pulse z-[100] font-bold shadow-lg">REC ●</div>
                             )}
                             {getAllActiveClips().visibleClips.map(({ clip }, index) => {
                                 const curveType = clip.fadeCurve || 'smooth';
                                 let opacity = clip.opacity / 100;
                                 let fadeFactor = 1;

                                 const timeInClip = currentVideoTime - clip.startTime;
                                 const timeFromEnd = (clip.startTime + clip.duration) - currentVideoTime;
                                 
                                 if (timeInClip < clip.fadeIn) {
                                     fadeFactor = calculateFadeFactor(timeInClip / clip.fadeIn, curveType);
                                 } else if (timeFromEnd < clip.fadeOut) {
                                     fadeFactor = calculateFadeFactor(timeFromEnd / clip.fadeOut, curveType);
                                 }
                                 
                                 opacity *= fadeFactor;

                                 return (
                                     <div key={clip.id}
                                        className="absolute top-1/2 left-1/2 origin-center"
                                        style={{
                                            width: clip.type === 'text' ? 'auto' : '100%',
                                            height: clip.type === 'text' ? 'auto' : '100%',
                                            transform: `translate(-50%, -50%) translate(${clip.positionX}px, ${clip.positionY}px) rotate(${clip.rotation}deg) scale(${clip.scale / 100})`,
                                            opacity: opacity,
                                            mixBlendMode: clip.blendMode !== 'normal' ? clip.blendMode : undefined,
                                            zIndex: index + 1,
                                            filter: `brightness(${clip.brightness}%) contrast(${clip.contrast}%) saturate(${clip.saturation}%) hue-rotate(${clip.hueRotate}deg) blur(${clip.blur}px) ${FILTER_PRESETS[clip.filterPreset || 'none']}`,
                                            whiteSpace: 'nowrap',
                                            pointerEvents: 'none',
                                            transition: 'none',
                                            willChange: 'opacity, transform' 
                                        }}
                                     >
                                         {clip.type === 'video' ? (
                                             <video 
                                                ref={(el) => {
                                                    const current = videoRefs.current.get(clip.id);
                                                    if (el && current !== el) videoRefs.current.set(clip.id, el);
                                                    else if (!el && current) videoRefs.current.delete(clip.id);
                                                }}
                                                src={clip.url} className="w-full h-full object-contain" playsInline muted={false} crossOrigin="anonymous" preload="auto"
                                                style={{ transition: 'none' }}
                                             />
                                         ) : clip.type === 'text' ? (
                                             <div style={{ fontSize: `${clip.fontSize}px`, color: clip.textColor, fontFamily: clip.fontFamily, backgroundColor: clip.backgroundColor, padding: '10px 20px', textShadow: '2px 2px 4px rgba(0,0,0,0.8)' }}>
                                                 {clip.textContent}
                                             </div>
                                         ) : (
                                             <img src={clip.url} className="w-full h-full object-contain" style={{ transition: 'none' }} />
                                         )}
                                     </div>
                                 );
                             })}
                         </div>
                         {!isRecorderMode && (
                         <div className="absolute top-4 left-1/2 -translate-x-1/2 text-sm bg-black/80 px-4 py-1 rounded-full font-mono text-white border border-slate-800 z-50">
                            {Math.floor(currentVideoTime).toFixed(2)}s
                         </div>
                         )}

                         {/* RECORDER FLOATING CONTROLS */}
                         {isRecorderMode && (
                             <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] flex gap-4 bg-slate-900/90 backdrop-blur border border-slate-700 p-4 rounded-2xl shadow-2xl items-center">
                                 {recordingState === 'idle' && (
                                     <>
                                        <div className="text-sm font-bold">1. اختر الشاشة</div>
                                        <button onClick={handleStartCapture} className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-xl font-bold transition-colors">
                                            بدء التقاط الشاشة
                                        </button>
                                        <button onClick={exitRecorderMode} className="text-slate-400 hover:text-white px-4 py-2">إلغاء</button>
                                     </>
                                 )}
                                 {recordingState === 'capturing' && (
                                     <>
                                         <div className="text-sm font-bold text-green-400">2. جاهز للتسجيل</div>
                                         <button onClick={handleStartRecording} className="bg-red-600 hover:bg-red-500 text-white px-8 py-2 rounded-xl font-bold animate-pulse">
                                             ● بدء التسجيل
                                         </button>
                                         <button onClick={exitRecorderMode} className="text-slate-400 hover:text-white px-4 py-2">إلغاء</button>
                                     </>
                                 )}
                                 {recordingState === 'recording' && (
                                     <>
                                         <div className="text-sm font-bold text-red-500 animate-pulse">جاري التسجيل...</div>
                                         <button onClick={handleStopRecording} className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-2 rounded-xl font-bold border border-slate-500">
                                             ■ إيقاف
                                         </button>
                                     </>
                                 )}
                             </div>
                         )}

                         {/* REVIEW MODAL */}
                         {isRecorderMode && recordingState === 'review' && recordedBlob && (
                             <div className="absolute inset-0 z-[101] bg-black/90 flex flex-col items-center justify-center p-8">
                                 <h2 className="text-2xl font-bold mb-4">تم الانتهاء! راجع الفيديو المسجل</h2>
                                 <video src={URL.createObjectURL(recordedBlob)} controls className="max-w-full max-h-[60vh] border border-slate-700 rounded-xl mb-6 shadow-2xl" />
                                 <div className="flex gap-4">
                                     <button onClick={handleDownloadRecording} className="bg-green-600 hover:bg-green-500 text-white px-8 py-3 rounded-xl font-bold flex items-center gap-2">
                                         <Icons.Download className="w-5 h-5"/> تنزيل الفيديو
                                     </button>
                                     <button onClick={exitRecorderMode} className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-xl font-bold">
                                         إغلاق
                                     </button>
                                 </div>
                             </div>
                         )}
                    </div>

                    {/* INSPECTOR */}
                    {!isRecorderMode && (
                    <div className="w-80 bg-[#1e1e1e] border-r border-[#333] flex flex-col overflow-hidden">
                        <div className="flex p-2 bg-[#252525] gap-1">
                            <button onClick={() => setActiveInspectorTab('props')} className={`px-3 py-1 text-xs rounded ${activeInspectorTab === 'props' ? 'bg-[#444]' : ''}`}>Props</button>
                            <button onClick={() => setActiveInspectorTab('effects')} className={`px-3 py-1 text-xs rounded ${activeInspectorTab === 'effects' ? 'bg-[#444]' : ''}`}>FX</button>
                            <button onClick={() => setActiveInspectorTab('ai')} className={`px-3 py-1 text-xs rounded ${activeInspectorTab === 'ai' ? 'bg-indigo-900' : ''}`}>AI</button>
                            {getSelectedClip()?.type === 'text' && <button onClick={() => setActiveInspectorTab('text')} className={`px-3 py-1 text-xs rounded ${activeInspectorTab === 'text' ? 'bg-[#444]' : ''}`}>Text</button>}
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
                            {activeInspectorTab === 'ai' && (
                                <div className="space-y-4">
                                    <div className="p-3 bg-indigo-900/20 border border-indigo-500/30 rounded">
                                        <h4 className="text-indigo-400 font-bold mb-2 text-xs">مساعد الذكاء الاصطناعي</h4>
                                        <button onClick={handleAiVideoAnalysis} disabled={isAiAnalyzing} className="w-full py-2 bg-indigo-600 rounded text-xs mb-2">{isAiAnalyzing ? 'جاري التحليل...' : 'تحليل وتصحيح الألوان'}</button>
                                        <div className="text-[10px] text-slate-300 whitespace-pre-line bg-black/50 p-2 rounded mb-2 min-h-[40px]">{aiAnalysisResult}</div>
                                        
                                        {aiPendingChanges.length > 0 && selectedClipId && (
                                            <div className="bg-black/40 rounded p-2 mb-2">
                                                <h5 className="text-[10px] text-white font-bold mb-2 border-b border-white/10 pb-1">الاقتراحات (حدد للتطبيق):</h5>
                                                <div className="space-y-1 mb-2">
                                                    {aiPendingChanges.map((change, idx) => (
                                                        <div key={idx} className="flex items-center gap-2 text-[10px] text-slate-300">
                                                            <input 
                                                                type="checkbox" 
                                                                checked={change.selected} 
                                                                onChange={() => toggleAiChangeSelection(idx)}
                                                                className="rounded border-slate-600"
                                                            />
                                                            <div className="flex-1 flex justify-between">
                                                                <span>{change.label}</span>
                                                                <span className="text-slate-500 font-mono">{change.oldValue} ➔ <span className="text-green-400">{change.newValue}</span></span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="flex gap-2">
                                                    <button onClick={handleApplyAiSuggestions} className="flex-1 py-1.5 bg-green-600 hover:bg-green-500 rounded text-[10px] font-bold text-white transition-colors">
                                                        تطبيق المحدد
                                                    </button>
                                                    <button onClick={() => setAiPendingChanges([])} className="px-3 py-1.5 bg-red-900/50 hover:bg-red-900 rounded text-[10px] text-white transition-colors">
                                                        إلغاء
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="p-3 bg-[#333] rounded">
                                        <h4 className="text-white font-bold mb-2 text-xs">توليد فيديو (Veo)</h4>
                                        <textarea value={aiIntroPrompt} onChange={e=>setAiIntroPrompt(e.target.value)} className="w-full bg-[#111] text-xs p-2 rounded mb-2" placeholder="وصف الفيديو..."></textarea>
                                        <button onClick={handleGenerateIntro} disabled={isAiAnalyzing} className="w-full py-2 bg-slate-600 rounded text-xs">توليد</button>
                                    </div>
                                </div>
                            )}
                            {activeInspectorTab === 'text' && getSelectedClip() && (
                                <div className="space-y-2">
                                    <textarea value={getSelectedClip()?.textContent} onChange={e => updateSelectedClip({textContent: e.target.value})} className="w-full bg-[#111] border border-[#333] p-2 text-sm" rows={3}></textarea>
                                    <div className="grid grid-cols-2 gap-2">
                                        <input type="number" value={getSelectedClip()?.fontSize} onChange={e => updateSelectedClip({fontSize: Number(e.target.value)})} className="bg-[#111] border border-[#333] p-1 text-xs"/>
                                        <input type="color" value={getSelectedClip()?.textColor} onChange={e => updateSelectedClip({textColor: e.target.value})} className="w-full h-6"/>
                                    </div>
                                </div>
                            )}
                            {activeInspectorTab === 'effects' && getSelectedClip() && (
                                <div className="space-y-4">
                                    <div>
                                        <label className="text-[10px] text-slate-400 font-bold mb-1 block">تصحح الألوان (Color Grading)</label>
                                        <div className="space-y-2 pl-2 border-l-2 border-[#444]">
                                            <div>
                                                <div className="flex justify-between text-[9px] text-slate-500"><span>Brightness</span><span>{getSelectedClip()?.brightness}%</span></div>
                                                <input type="range" max="200" value={getSelectedClip()?.brightness} onChange={e=>updateSelectedClip({brightness: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                            </div>
                                            <div>
                                                <div className="flex justify-between text-[9px] text-slate-500"><span>Contrast</span><span>{getSelectedClip()?.contrast}%</span></div>
                                                <input type="range" max="200" value={getSelectedClip()?.contrast} onChange={e=>updateSelectedClip({contrast: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                            </div>
                                            <div>
                                                <div className="flex justify-between text-[9px] text-slate-500"><span>Saturation</span><span>{getSelectedClip()?.saturation}%</span></div>
                                                <input type="range" max="200" value={getSelectedClip()?.saturation} onChange={e=>updateSelectedClip({saturation: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                            </div>
                                            <div>
                                                <div className="flex justify-between text-[9px] text-slate-500"><span>Hue Rotate</span><span>{getSelectedClip()?.hueRotate}deg</span></div>
                                                <input type="range" max="360" value={getSelectedClip()?.hueRotate} onChange={e=>updateSelectedClip({hueRotate: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                            </div>
                                        </div>
                                    </div>
                                    <hr className="border-[#333]"/>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Fade In/Out (Sec)</label>
                                        <div className="flex gap-2">
                                            <input type="number" step="0.1" value={getSelectedClip()?.fadeIn} onChange={e=>updateSelectedClip({fadeIn: Number(e.target.value)})} className="w-full bg-[#111] text-xs p-1 rounded"/>
                                            <input type="number" step="0.1" value={getSelectedClip()?.fadeOut} onChange={e=>updateSelectedClip({fadeOut: Number(e.target.value)})} className="w-full bg-[#111] text-xs p-1 rounded"/>
                                        </div>
                                        <label className="text-[10px] text-slate-400 mt-2 block">Fade Curve</label>
                                        <select value={getSelectedClip()?.fadeCurve || 'smooth'} onChange={e=>updateSelectedClip({fadeCurve: e.target.value as any})} className="w-full bg-[#111] text-xs p-1 rounded mt-1">
                                            <option value="linear">Linear (Hard)</option>
                                            <option value="smooth">Smooth (Standard)</option>
                                            <option value="buttery">Buttery (Very Smooth)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Filters</label>
                                        <div className="grid grid-cols-3 gap-1 mt-1">
                                            {Object.keys(FILTER_PRESETS).map(k => (
                                                <button key={k} onClick={()=>updateSelectedClip({filterPreset: k as any})} className={`text-[9px] p-1 border ${getSelectedClip()?.filterPreset === k ? 'border-indigo-500 bg-indigo-900' : 'border-[#444]'}`}>{k}</button>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                         <label className="text-[10px] text-slate-400">Blur ({getSelectedClip()?.blur}px)</label>
                                         <input type="range" max="20" value={getSelectedClip()?.blur} onChange={e=>updateSelectedClip({blur: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                </div>
                            )}
                            {activeInspectorTab === 'props' && getSelectedClip() && (
                                <div className="space-y-4">
                                    <button onClick={handleSaveProject} className="w-full py-2 bg-slate-700 hover:bg-slate-600 rounded text-xs text-white mb-2">💾 حفظ التعديلات</button>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Volume ({getSelectedClip()?.volume}%)</label>
                                        <input type="range" max="100" value={getSelectedClip()?.volume || 100} onChange={e=>updateSelectedClip({volume: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Speed ({getSelectedClip()?.speed}%)</label>
                                        <input type="range" min="50" max="200" value={getSelectedClip()?.speed || 100} onChange={e=>updateSelectedClip({speed: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Scale ({getSelectedClip()?.scale}%)</label>
                                        <input type="range" max="300" value={getSelectedClip()?.scale} onChange={e=>updateSelectedClip({scale: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Rotation ({getSelectedClip()?.rotation}°)</label>
                                        <input type="range" min="-180" max="180" value={getSelectedClip()?.rotation} onChange={e=>updateSelectedClip({rotation: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Position X/Y</label>
                                        <div className="flex gap-2">
                                            <input type="number" value={getSelectedClip()?.positionX} onChange={e=>updateSelectedClip({positionX: Number(e.target.value)})} className="w-full bg-[#111] text-xs p-1 rounded"/>
                                            <input type="number" value={getSelectedClip()?.positionY} onChange={e=>updateSelectedClip({positionY: Number(e.target.value)})} className="w-full bg-[#111] text-xs p-1 rounded"/>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Opacity ({getSelectedClip()?.opacity}%)</label>
                                        <input type="range" max="100" value={getSelectedClip()?.opacity} onChange={e=>updateSelectedClip({opacity: Number(e.target.value)})} className="w-full h-1 bg-slate-700 appearance-none rounded"/>
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-slate-400">Blend Mode</label>
                                        <select value={getSelectedClip()?.blendMode} onChange={e=>updateSelectedClip({blendMode: e.target.value as any})} className="w-full bg-[#111] text-xs p-1 rounded">
                                            <option value="normal">Normal</option>
                                            <option value="screen">Screen</option>
                                            <option value="multiply">Multiply</option>
                                            <option value="overlay">Overlay</option>
                                        </select>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    )}
                </div>

                {/* TIMELINE */}
                {!isRecorderMode && (
                <div className="h-72 bg-[#181818] border-t border-[#333] flex flex-col shrink-0">
                     <div className="h-10 border-b border-[#333] flex items-center px-4 gap-2 bg-[#252525] justify-between">
                         <div className="flex items-center gap-2">
                            <button onClick={handleVideoUndo} title="تراجع" className="hover:text-white text-slate-400"><Icons.Undo/></button>
                            <button onClick={handleVideoRedo} title="إعادة" className="hover:text-white text-slate-400"><Icons.Redo/></button>
                            <div className="w-px h-4 bg-[#444] mx-1"></div>
                            <button onClick={toggleVideoPlay}>{isVideoPlaying ? <Icons.Pause/> : <Icons.Play/>}</button>
                            <div className="w-px h-4 bg-[#444] mx-1"></div>
                            {/* NEW: Explicit Split and Delete Buttons */}
                            <button onClick={handleSplitAtPlayhead} title="قص عند المؤشر (Split)" className="hover:text-white text-slate-400"><Icons.Scissors/></button>
                            <button onClick={handleDeleteClip} title="حذف المقطع (Delete)" className="hover:text-red-500 text-slate-400"><Icons.Trash/></button>
                            <div className="w-px h-4 bg-[#444] mx-1"></div>
                            <button onClick={() => setVideoEditTool('razor')} title="أداة الموسى" className={videoEditTool === 'razor' ? 'text-indigo-400' : 'text-slate-400'}><Icons.Razor/></button>
                            <button onClick={() => setVideoEditTool('move')} title="أداة التحريك" className={videoEditTool === 'move' ? 'text-indigo-400' : 'text-slate-400'}><Icons.Hand/></button>
                            <input type="range" min="5" max="100" value={timelineScale} onChange={e=>setTimelineScale(Number(e.target.value))} className="w-24"/>
                         </div>
                         <div className="flex items-center gap-3">
                             <button onClick={handleSaveProject} className="flex items-center gap-2 text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded">
                                <Icons.Save className="w-3 h-3"/> حفظ المشروع
                             </button>
                             <button onClick={enterRecorderMode} className="flex items-center gap-2 text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded font-bold text-white">
                                <Icons.Video className="w-3 h-3"/> تسجيل فيديو (تصدير)
                             </button>
                         </div>
                     </div>
                     <div ref={timelineScrollRef} className="flex-1 overflow-auto relative custom-scrollbar bg-[#181818]" onMouseDown={handleTimelineMouseDownWrapper}>
                         <div ref={timelineContainerRef} 
                              style={{ width: timelineWidth, minWidth: '100%' }} 
                              className="relative min-h-full">
                             
                             {/* RULER */}
                             <div className="h-6 border-b border-[#333] sticky top-0 bg-[#181818] z-20 text-[10px] text-slate-500 whitespace-nowrap"
                                  style={{ width: '100%' }}>
                                 {Array.from({length: Math.ceil(maxTime/5)}).map((_, i) => (
                                    <span key={i} className="absolute border-l border-[#333] pl-1 h-2" style={{ left: (i * 5 * timelineScale) + HEADER_WIDTH }}>{i*5}s</span>
                                 ))}
                             </div>
                             
                             {/* PLAYHEAD */}
                             <div className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none shadow-[0_0_5px_rgba(239,68,68,0.5)]" style={{ left: (currentVideoTime * timelineScale) + HEADER_WIDTH }}></div>
                             
                             {/* VIDEO TRACKS */}
                             {videoTracks.map(track => (
                                 <div key={track.id} 
                                      className="h-24 bg-[#111] border-b border-[#333] relative flex" 
                                      style={{ width: timelineWidth }}
                                      onDragOver={handleTrackDragOver} 
                                      onDrop={(e)=>handleTrackDrop(e, track.id, false)}>
                                     
                                     {/* Sticky Header */}
                                     <div className="sticky left-0 top-0 bottom-0 bg-[#222] border-r border-[#333] z-10 flex flex-col justify-center items-center text-xs font-bold text-slate-500 shrink-0 px-1 gap-1"
                                          style={{ width: HEADER_WIDTH }}>
                                         <div className="truncate w-full text-center">{track.name}</div>
                                         <div className="flex gap-2 w-full justify-center">
                                            <button onClick={(e)=>{e.stopPropagation(); toggleTrackMute(track.id, false)}} className={track.isMuted?'text-red-500':''}>M</button>
                                         </div>
                                     </div>

                                     {/* Clips Area */}
                                     <div className="absolute top-0 bottom-0 right-0" style={{ left: HEADER_WIDTH }}>
                                         {track.clips.map(clip => (
                                             <div key={clip.id} onMouseDown={(e)=>handleClipMouseDown(e, clip, track.id, false)} 
                                                className={`absolute top-1 bottom-1 rounded overflow-hidden cursor-pointer border ${selectedClipId === clip.id ? 'border-white z-10' : 'border-slate-700 opacity-90'} ${clip.type === 'text' ? 'bg-purple-900' : 'bg-indigo-900/50'}`}
                                                style={{ 
                                                    left: clip.startTime * timelineScale, 
                                                    width: (clip.duration * timelineScale) + 1,
                                                    boxShadow: '0.5px 0 0 rgba(0,0,0,0.5)' // Gap filler
                                                }}
                                             >
                                                 <div className="p-1 text-[10px] truncate bg-black/50 text-white select-none">{clip.name}</div>
                                                 <div className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${(clip.fadeIn / clip.duration)*100}%`, background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.2))' }}></div>
                                                 <div className="absolute inset-y-0 right-0 bg-white/10" style={{ width: `${(clip.fadeOut / clip.duration)*100}%`, background: 'linear-gradient(to left, transparent, rgba(255,255,255,0.2))' }}></div>
                                             </div>
                                         ))}
                                     </div>
                                 </div>
                             ))}
                             
                             {/* AUDIO TRACKS */}
                             {timelineAudioTracks.map(track => (
                                 <div key={track.id} 
                                      className="h-12 bg-[#0f0f0f] border-b border-[#333] relative flex mt-2" 
                                      style={{ width: timelineWidth }}
                                      onDragOver={handleTrackDragOver} 
                                      onDrop={(e)=>handleTrackDrop(e, track.id, true)}>
                                      
                                      <div className="sticky left-0 top-0 bottom-0 bg-[#1a1a1a] border-r border-[#333] z-10 flex flex-col justify-center items-center text-xs font-bold text-slate-500 shrink-0 px-1 gap-1"
                                           style={{ width: HEADER_WIDTH }}>
                                           <div className="truncate w-full text-center">{track.name}</div>
                                           <button onClick={(e)=>{e.stopPropagation(); toggleTrackMute(track.id, true)}} className={track.isMuted?'text-red-500':''}>M</button>
                                      </div>

                                      <div className="absolute top-0 bottom-0 right-0" style={{ left: HEADER_WIDTH }}>
                                         {track.clips.map(clip => (
                                             <div key={clip.id} onMouseDown={(e)=>handleClipMouseDown(e, clip, track.id, true)} className="absolute top-1 bottom-1 bg-green-900/50 border border-green-700 rounded cursor-pointer" style={{ left: clip.startTime * timelineScale, width: clip.duration * timelineScale }}>
                                                 <div className="p-1 text-[9px] truncate text-white select-none">{clip.name}</div>
                                             </div>
                                         ))}
                                      </div>
                                 </div>
                             ))}
                         </div>
                     </div>
                </div>
                )}
            </div>
        )}
        
        {/* AUDIO STUDIO */}
        {activeWorkspace === Workspace.AUDIO && (
            <div className="flex-1 flex flex-col bg-[#121212] p-6 overflow-hidden">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-indigo-400">ستوديو الهندسة الصوتية</h2>
                    <div className="flex gap-2">
                        <button onClick={toggleAudioStudioPlay} className={`px-6 py-2 rounded-full font-bold flex items-center gap-2 ${isAudioStudioPlaying ? 'bg-red-600' : 'bg-green-600'}`}>
                            {isAudioStudioPlaying ? <Icons.Pause/> : <Icons.Play/>} {isAudioStudioPlaying ? 'إيقاف' : 'تشغيل الكل'}
                        </button>
                        <button className="bg-slate-800 px-4 py-2 rounded-full text-sm">تصدير Mixdown</button>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 overflow-y-auto">
                    {/* Mixer Panel */}
                    <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#333] flex flex-col">
                        <h3 className="text-sm font-bold text-slate-400 mb-4 flex items-center gap-2"><Icons.Sliders className="w-4 h-4"/> Mixer Console</h3>
                        <div className="flex-1 overflow-x-auto custom-scrollbar flex gap-4 pb-2">
                            {audioStudioTracks.map(track => (
                                <div key={track.id} className="w-24 bg-[#111] border border-[#333] rounded-lg p-2 flex flex-col items-center justify-between shrink-0">
                                    <div className="text-xs text-slate-300 truncate w-full text-center font-bold mb-2">{track.name}</div>
                                    
                                    {/* EQ Knobs (REAL) */}
                                    <div className="flex flex-col gap-2 mb-2">
                                        {[
                                            { label: 'HI', prop: 'high' as const }, 
                                            { label: 'MID', prop: 'mid' as const }, 
                                            { label: 'LO', prop: 'low' as const }
                                        ].map(knob => (
                                            <div key={knob.prop} className="relative group flex flex-col items-center">
                                                <div className="w-8 h-8 rounded-full border-2 border-slate-600 bg-slate-800 flex items-center justify-center text-[8px] text-slate-400">
                                                    {track.eq[knob.prop] > 0 ? `+${track.eq[knob.prop]}` : track.eq[knob.prop]}
                                                </div>
                                                <input 
                                                    type="range" min="-12" max="12" step="1"
                                                    value={track.eq[knob.prop]}
                                                    onChange={(e) => updateAudioTrack(track.id, { eq: { ...track.eq, [knob.prop]: Number(e.target.value) } })}
                                                    className="absolute inset-0 opacity-0 cursor-ew-resize"
                                                    title={knob.label}
                                                />
                                            </div>
                                        ))}
                                    </div>

                                    {/* Volume Slider */}
                                    <div className="h-32 w-2 bg-[#222] rounded-full relative group">
                                        <div className="absolute bottom-0 w-full bg-indigo-500 rounded-full" style={{ height: `${track.volume}%` }}></div>
                                        <input 
                                            type="range" 
                                            min="0" max="100" 
                                            value={track.volume} 
                                            onChange={(e) => updateAudioTrack(track.id, { volume: Number(e.target.value) })}
                                            className="absolute inset-0 opacity-0 cursor-pointer h-full" 
                                            style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                                        />
                                    </div>
                                    
                                    <div className="flex gap-1 mt-2 w-full">
                                        <button onClick={() => updateAudioTrack(track.id, { isMuted: !track.isMuted })} className={`flex-1 text-[9px] py-1 rounded ${track.isMuted ? 'bg-red-600 text-white' : 'bg-[#333] text-slate-400'}`}>M</button>
                                        <button onClick={() => updateAudioTrack(track.id, { isSolo: !track.isSolo })} className={`flex-1 text-[9px] py-1 rounded ${track.isSolo ? 'bg-yellow-600 text-white' : 'bg-[#333] text-slate-400'}`}>S</button>
                                    </div>

                                    {/* Hidden Audio Element Source */}
                                    <audio 
                                        ref={el => {
                                            if (el && !audioStudioRefs.current.has(track.id)) {
                                                audioStudioRefs.current.set(track.id, el);
                                            }
                                        }}
                                        src={track.url} 
                                        loop 
                                        crossOrigin="anonymous"
                                        onEnded={() => {}}
                                    />
                                </div>
                            ))}
                            {audioStudioTracks.length === 0 && (
                                <div className="text-slate-600 text-sm m-auto">لا توجد مسارات صوتية</div>
                            )}
                        </div>
                    </div>

                    {/* Track List */}
                    <div className="space-y-4">
                         {audioStudioTracks.map(track => (
                             <div key={track.id} className="bg-[#1a1a1a] border border-[#333] rounded-xl p-4 flex items-center gap-4">
                                 <div className="w-10 h-10 bg-indigo-900 rounded-full flex items-center justify-center">
                                     <Icons.Music className="w-5 h-5 text-indigo-400"/>
                                 </div>
                                 <div className="flex-1">
                                     <div className="font-bold text-sm text-white mb-1">{track.name}</div>
                                     <div className="w-full h-8 bg-black/50 rounded overflow-hidden flex items-center">
                                         {/* Fake Waveform */}
                                         <div className="w-full h-full flex items-center justify-center gap-0.5 px-2">
                                             {Array.from({length: 40}).map((_, i) => (
                                                 <div key={i} className="w-1 bg-green-600 rounded-full" style={{ height: `${Math.random() * 80 + 20}%` }}></div>
                                             ))}
                                         </div>
                                     </div>
                                 </div>
                                 <button onClick={() => {
                                     if(audioGraphRef.current) audioGraphRef.current.removeTrack(track.id);
                                     setAudioStudioTracks(p => p.filter(t => t.id !== track.id));
                                 }} className="text-slate-500 hover:text-red-500">
                                     <Icons.Trash/>
                                 </button>
                             </div>
                         ))}
                         {audioStudioTracks.length === 0 && (
                             <div className="text-center text-slate-500 py-10 border-2 border-dashed border-[#333] rounded-xl">
                                 <Icons.Mic className="w-12 h-12 mx-auto mb-2 opacity-50"/>
                                 <p>قم باستيراد ملفات صوتية من القائمة الجانبية</p>
                             </div>
                         )}
                    </div>
                </div>
            </div>
        )}

      </main>
    </div>
  );
};

export default App;
