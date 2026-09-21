import React from "react";
import { AbsoluteFill, Video, Audio } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";

export const VideoComp = ({ scenes }) => {
  if (!scenes || scenes.length === 0) return null;
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <TransitionSeries>
        {scenes.map((scene, i) => {
          const duration = scene.durationFrames || 150;
          return (
            <React.Fragment key={i}>
              <TransitionSeries.Sequence durationInFrames={duration}>
                {scene.videoUrl && <Video src={scene.videoUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                {scene.audioUrl && <Audio src={scene.audioUrl} />}
              </TransitionSeries.Sequence>
              {i < scenes.length - 1 && (
                <TransitionSeries.Transition
                  presentation={slide({ direction: "from-right" })}
                  timing={linearTiming({ durationInFrames: 15 })}
                />
              )}
            </React.Fragment>
          );
        })}
      </TransitionSeries>
    </AbsoluteFill>
  );
};