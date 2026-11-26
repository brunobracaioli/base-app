import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { AppProviders } from '../../shell/ui/app-providers';
import { MaintenanceGateContent, UpdateGateContent } from './app-config-gate-screens';

beforeEach(() => {
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);
});

describe('app config gate screens', () => {
  it('opens the store only after the user taps the update action', async () => {
    const openStore = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
    await render(
      <AppProviders initialLocale="en">
        <UpdateGateContent
          storeUrl="https://apps.apple.com/app/id0000000000"
          openStore={openStore}
        />
      </AppProviders>,
    );

    expect(openStore).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Update now' }));
    expect(openStore).toHaveBeenCalledWith('https://apps.apple.com/app/id0000000000');
  });

  it('uses the default maintenance translation for an unknown message key', async () => {
    await render(
      <AppProviders initialLocale="en">
        <MaintenanceGateContent messageKey="maintenance.not-in-this-build" until={null} />
      </AppProviders>,
    );

    expect(screen.getByText('Please try again later.')).toBeTruthy();
    expect(screen.queryByText('maintenance.not-in-this-build')).toBeNull();
  });
});
