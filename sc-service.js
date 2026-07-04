import play from 'play-dl';

const MY_CLIENT_ID = "O7atZypwLvuWSY9hWnnQ3vrLTHH7wqMe";
play.setToken({ soundcloud: { client_id: MY_CLIENT_ID } });

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export async function searchTracks(query, limit = 10, offset = 0) {
    try {
        const results = await play.search(query, { 
            limit: offset + limit, 
            source: { soundcloud: "tracks" } 
        });
        
        return results.slice(offset, offset + limit).map(t => ({
            id: t.id,
            title: t.name,
            artist: t.user?.name || 'Artist',
            duration: formatDuration(Math.floor((t.durationInMs || 0) / 1000)),
            permalink_url: t.url,
        }));
    } catch (e) {
        console.error("Ошибка поиска:", e);
        return [];
    }
}

export async function downloadTrackStream(url) {
    try {
        const streamData = await play.stream(url);
        return streamData.stream;
    } catch (e) {
        console.error("Ошибка стрима:", e);
        throw new Error("Не удалось загрузить трек. Возможно он ограничен авторским правом на скачивание.");
    }
}