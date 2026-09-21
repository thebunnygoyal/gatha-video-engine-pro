import { Composition } from "remotion";
import { VideoComp } from "./VideoComp";

export const Root = () => {
  return (
    <Composition
      id="Main"
      component={VideoComp}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ scenes: [] }}
    />
  );
};