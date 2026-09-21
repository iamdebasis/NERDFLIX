import { useState } from 'react';
import { LibraryPicker } from './LibraryPicker';
import { Browse } from './Browse';
import { ALL_LIBRARIES } from '../../shared/types';

export function App() {
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);

  if (picked) {
    return (
      <Browse
        // The combined card browses every library: buildBrowseData treats an absent
        // volume id as "no filter".
        volumeId={picked.id === ALL_LIBRARIES ? undefined : picked.id}
        libraryLabel={picked.label}
        onBack={() => setPicked(null)}
      />
    );
  }
  return <LibraryPicker onPick={(id, label) => setPicked({ id, label })} />;
}
