import { audio } from '../audio';
import { AudioClip } from '../audioClip';

/** Sound file extensions Import accepts. What decodes depends on the browser; these work in all current ones. */
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'oga', 'flac', 'm4a', 'aac'];

export const isAudioFile = (name: string) => AUDIO_EXTENSIONS.includes(name.split('?')[0].split('.').pop()?.toLowerCase() ?? '');

/** Decodes a sound file into a clip named after the file. */
export async function loadAudioClip(fileName: string, data: ArrayBuffer): Promise<AudioClip> {
  const name = decodeURIComponent(fileName.split('/').pop() ?? fileName).replace(/\.[^.]+$/, '');
  return AudioClip.fromAudioBuffer(await audio.decode(data), name);
}
