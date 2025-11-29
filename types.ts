
export enum Workspace {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO'
}

export enum ToolMode {
  GENERATION = 'GENERATION', // Text to Image
  REMOVE_BG = 'REMOVE_BG', // Like RemoveBG
  OBJECT_REMOVAL = 'OBJECT_REMOVAL', // Like ClipDrop Cleanup
  REPLACE_BG = 'REPLACE_BG', // Like Adobe Firefly/Photoroom
  UPSCALE = 'UPSCALE', // Like Remini/Replicate Upscalers
  RELIGHT = 'RELIGHT', // Like ClipDrop Relight
  NANO_BANANA = 'NANO_BANANA', // Gemini Flash Image (Nano Banana)
  MANUAL = 'MANUAL', // Standard CSS Filters
  VISION = 'VISION', // Image Analysis
  SMART_DASHBOARD = 'SMART_DASHBOARD' // New Dashboard Mode
}

export interface ManualFilters {
  brightness: number; // 0-200, default 100
  contrast: number;   // 0-200, default 100
  saturation: number; // 0-200, default 100
  blur: number;       // 0-20px, default 0
  grayscale: number;  // 0-100, default 0
  sepia: number;      // 0-100, default 0
}

export const DEFAULT_FILTERS: ManualFilters = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  grayscale: 0,
  sepia: 0
};

export interface SmartSuggestion {
  id: string;
  label: string;
  description: string;
  tool: ToolMode;
  prompt: string;
}

export interface GalleryImage {
  id: string;
  originalData: string; // The base64 of the original upload
  currentData: string; // The base64 of the current state
  history: string[]; // Stack of base64 states for Undo/Redo
  historyIndex: number;
  filters: ManualFilters; // Current manual filters
  isProcessing: boolean;
  suggestions: SmartSuggestion[];
}

// --- VIDEO EDITING TYPES ---
export interface VideoClip {
  id: string;
  name: string;
  url: string; // Blob URL (or empty if text)
  type: 'video' | 'image' | 'text';
  
  // Metadata
  originalDuration: number;
  width: number;
  height: number;

  // Timeline
  duration: number; // Playback duration
  startTime: number; // Position on timeline
  trimStart: number; // Offset into the source file
  trimEnd: number;   // Source end offset
  
  // Visual Properties
  opacity: number;
  scale: number;
  rotation: number;
  positionX: number;
  positionY: number;
  blendMode: 'normal' | 'screen' | 'multiply' | 'overlay' | 'darken' | 'lighten';

  // Effects & Color
  brightness: number; // 0-200
  contrast: number;   // 0-200
  saturation: number; // 0-200
  hueRotate: number;  // 0-360
  blur: number;       // 0-20px
  filterPreset: 'none' | 'grayscale' | 'sepia' | 'vintage' | 'cyberpunk' | 'warm' | 'cool' | 'drama';
  
  // Transitions
  fadeIn: number; // duration in seconds
  fadeOut: number; // duration in seconds
  fadeCurve: 'linear' | 'smooth' | 'buttery'; // New property for fade smoothness

  // Text Properties (Only for type='text')
  textContent?: string;
  fontSize?: number;
  textColor?: string;
  fontFamily?: string;
  backgroundColor?: string; // transparent allowed

  // Audio
  volume: number;
  speed: number;
}

export interface VideoTrack {
  id: string;
  name: string;
  clips: VideoClip[];
  isMuted: boolean;
  isLocked: boolean;
}

// --- AUDIO EDITING TYPES ---
export interface AudioTrack {
  id: string;
  name: string;
  url: string;
  duration: number;
  volume: number;
  pan: number; // -1 to 1
  isMuted: boolean;
  isSolo: boolean;
  eq: {
    low: number; // -12 to 12 dB
    mid: number;
    high: number;
  };
  reverb: number; // 0 to 100%
}
